//! Configuration, parsed once at boot and never re-read.
//!
//! Everything arrives as environment variables set by Pulumi, so a missing or
//! malformed value is a deployment that should not start rather than a request
//! that fails later. The one exception is Telegram, which is absent whenever
//! nobody wants notifying.

use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};

/// A directory the picker browses and the process may write to.
///
/// The host path and the container path are the same string. That is what lets
/// a path travel from the browse endpoint to aria2's `dir` without either side
/// translating it — aria2 writes where the pod mounted it, and the mount is the
/// root, so there is one name for a place rather than two that can disagree.
pub struct Root {
    pub name: String,
    pub path: PathBuf,
}

pub struct Oidc {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
}

pub struct Telegram {
    pub bot_token: String,
    pub chat_id: String,
}

pub struct Config {
    pub bind_addr: String,
    pub aria2_rpc_url: String,
    pub roots: Vec<Root>,
    /// Where this is reached from outside, which is what the OAuth redirect URI
    /// has to match — the pod cannot infer it from a request it has not had yet.
    pub public_url: String,
    pub oidc: Oidc,
    pub telegram: Option<Telegram>,
}

fn var(key: &str) -> Result<String> {
    std::env::var(key).with_context(|| format!("{key} is not set"))
}

fn var_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let roots = parse_roots(&var("ROOTS")?)?;
        if roots.is_empty() {
            bail!("ROOTS is empty: with no root there is nowhere to download to");
        }

        // Both halves or neither. A bot token with no chat id fails on the first
        // send, hours after the deploy that introduced it.
        let telegram = match (
            std::env::var("TELEGRAM_BOT_TOKEN")
                .ok()
                .filter(|s| !s.is_empty()),
            std::env::var("TELEGRAM_CHAT_ID")
                .ok()
                .filter(|s| !s.is_empty()),
        ) {
            (Some(bot_token), Some(chat_id)) => Some(Telegram { bot_token, chat_id }),
            (None, None) => None,
            _ => bail!("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set together"),
        };

        Ok(Self {
            bind_addr: var_or("BIND_ADDR", "0.0.0.0:8080"),
            aria2_rpc_url: var_or("ARIA2_RPC_URL", "http://127.0.0.1:6800/jsonrpc"),
            roots,
            public_url: var("PUBLIC_URL")?.trim_end_matches('/').to_string(),
            oidc: Oidc {
                issuer: var("OIDC_ISSUER")?.trim_end_matches('/').to_string(),
                client_id: var("OIDC_CLIENT_ID")?,
                client_secret: var("OIDC_CLIENT_SECRET")?,
            },
            telegram,
        })
    }

    pub fn redirect_uri(&self) -> String {
        format!("{}/auth/callback", self.public_url)
    }

    /// Resolve a path the browser sent into one inside a configured root.
    ///
    /// This is the containment boundary, and it is deliberately lexical rather
    /// than filesystem-based: `canonicalize` cannot answer for a directory that
    /// does not exist yet, which is exactly the case `mkdir` and a new season
    /// folder present. So `..` is refused outright rather than resolved and
    /// checked, since a rejected traversal needs no argument about symlinks.
    ///
    /// An empty path means "the roots themselves" and resolves to nothing —
    /// callers list `roots` for that rather than asking here.
    pub fn resolve(&self, path: &str) -> Option<PathBuf> {
        let candidate = Path::new(path);
        if !candidate.is_absolute() {
            return None;
        }
        if candidate
            .components()
            .any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
        {
            return None;
        }
        self.roots
            .iter()
            .any(|r| candidate.starts_with(&r.path))
            .then(|| candidate.to_path_buf())
    }

    /// What the picker calls a path: the root's name, then whatever is below
    /// it, so `/mnt/kontent/tv/some-show` reads as `tv/some-show`.
    ///
    /// The mount point above a root is a fact about how the pod is assembled
    /// and answers nothing about where a download lands, but it is the part of
    /// a path a phone-width line spends its width on first — and the tail, the
    /// part that does answer, is what gets pushed onto a second line or off the
    /// end. The root's own name is used rather than its last path segment
    /// because `ROOTS` names each root independently of where it is mounted.
    ///
    /// A path outside every root comes back unchanged. Nothing renders one —
    /// the picker only labels paths it has already resolved — so there is
    /// nothing to design for beyond not losing the string.
    pub fn label(&self, path: &Path) -> String {
        self.roots
            .iter()
            .find_map(|root| {
                let rest = path.strip_prefix(&root.path).ok()?;
                Some(match rest.as_os_str().is_empty() {
                    true => root.name.clone(),
                    false => format!("{}/{}", root.name, rest.display()),
                })
            })
            .unwrap_or_else(|| path.display().to_string())
    }

    /// Resolve a path that must already exist, following symlinks.
    ///
    /// [`Self::resolve`] cannot answer for symlinks, because it is deciding
    /// about names rather than about the filesystem: a link at
    /// `<root>/somewhere` pointing at `/etc` passes it, and every component of
    /// the result is still lexically inside the root. For reading a directory
    /// that is a leak; for unlinking a file it is worse.
    ///
    /// So anything that touches an existing path re-checks it here, where
    /// `canonicalize` has resolved the links and containment can be decided
    /// about the real target. The two exist separately because the lexical one
    /// is the only one that can answer for a directory nobody has created yet,
    /// which is the case naming a new season folder presents.
    pub async fn resolve_existing(&self, path: &str) -> Option<PathBuf> {
        let lexical = self.resolve(path)?;
        let real = tokio::fs::canonicalize(&lexical).await.ok()?;
        // The roots are canonicalised too. A root that is itself a symlink —
        // which a media mount can easily be — would otherwise never match its
        // own resolved contents, and every path under it would be refused.
        for root in &self.roots {
            if let Ok(root) = tokio::fs::canonicalize(&root.path).await
                && real.starts_with(&root)
            {
                return Some(real);
            }
        }
        None
    }
}

/// `name:/path,name:/path`. Split on the last colon of each pair so a name is
/// never taken out of the middle of a path.
fn parse_roots(raw: &str) -> Result<Vec<Root>> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|pair| {
            let (name, path) = pair
                .split_once(':')
                .with_context(|| format!("ROOTS entry {pair:?} is not name:path"))?;
            let path = PathBuf::from(path);
            if !path.is_absolute() {
                bail!("ROOTS entry {pair:?} has a relative path");
            }
            Ok(Root {
                name: name.to_string(),
                path,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conf(roots: &[(&str, &str)]) -> Config {
        Config {
            bind_addr: String::new(),
            aria2_rpc_url: String::new(),
            roots: roots
                .iter()
                .map(|(n, p)| Root {
                    name: n.to_string(),
                    path: PathBuf::from(p),
                })
                .collect(),
            public_url: String::new(),
            oidc: Oidc {
                issuer: String::new(),
                client_id: String::new(),
                client_secret: String::new(),
            },
            telegram: None,
        }
    }

    #[test]
    fn roots_parse_as_pairs() {
        let roots = parse_roots("tv:/mnt/kontent/tv, movies:/mnt/kontent/movies").unwrap();
        assert_eq!(roots.len(), 2);
        assert_eq!(roots[1].name, "movies");
        assert_eq!(roots[1].path, PathBuf::from("/mnt/kontent/movies"));
    }

    #[test]
    fn a_relative_root_is_rejected() {
        assert!(parse_roots("tv:kontent/tv").is_err());
    }

    #[test]
    fn resolve_accepts_a_path_inside_a_root() {
        let c = conf(&[("tv", "/mnt/kontent/tv")]);
        assert_eq!(
            c.resolve("/mnt/kontent/tv/Show/S02"),
            Some(PathBuf::from("/mnt/kontent/tv/Show/S02"))
        );
    }

    #[test]
    fn resolve_refuses_traversal_and_anything_outside() {
        let c = conf(&[("tv", "/mnt/kontent/tv")]);
        assert_eq!(c.resolve("/mnt/kontent/tv/../../etc"), None);
        assert_eq!(c.resolve("/etc/passwd"), None);
        assert_eq!(c.resolve("relative/path"), None);
        assert_eq!(c.resolve(""), None);
    }

    #[test]
    fn label_starts_at_the_root_that_was_picked() {
        let c = conf(&[("tv", "/mnt/kontent/tv"), ("movies", "/mnt/kontent/movies")]);
        assert_eq!(
            c.label(Path::new("/mnt/kontent/tv/some-show")),
            "tv/some-show"
        );
        assert_eq!(c.label(Path::new("/mnt/kontent/tv")), "tv");
        assert_eq!(
            c.label(Path::new("/mnt/kontent/movies/Harbourlight/disc 1")),
            "movies/Harbourlight/disc 1"
        );
    }

    /// The root's name is the label, not its last path segment — `ROOTS` sets
    /// the two independently and the picker offers the name, so a label built
    /// from the mount would disagree with the entry that was tapped to get
    /// here.
    #[test]
    fn label_uses_the_configured_name_rather_than_the_directory_name() {
        let c = conf(&[("music", "/mnt/kontent/navidrome-media")]);
        assert_eq!(
            c.label(Path::new("/mnt/kontent/navidrome-media/Boards of Canada")),
            "music/Boards of Canada"
        );
    }

    /// Nothing renders a path from outside a root, but losing the string would
    /// turn a bug into a blank line saying nothing.
    #[test]
    fn label_leaves_a_path_outside_every_root_alone() {
        let c = conf(&[("tv", "/mnt/kontent/tv")]);
        assert_eq!(c.label(Path::new("/etc/passwd")), "/etc/passwd");
        assert_eq!(
            c.label(Path::new("/mnt/kontent/tv-old")),
            "/mnt/kontent/tv-old"
        );
    }

    /// A sibling whose name merely starts with the root's is not inside it.
    /// `starts_with` on `Path` compares components, which is what makes this
    /// hold — the same check written on the strings would let it through.
    #[test]
    fn resolve_refuses_a_prefix_neighbour() {
        let c = conf(&[("tv", "/mnt/kontent/tv")]);
        assert_eq!(c.resolve("/mnt/kontent/tv-old/secrets"), None);
    }
}
