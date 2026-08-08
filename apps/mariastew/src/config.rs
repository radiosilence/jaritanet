//! Configuration, parsed once at boot and never re-read.
//!
//! Everything arrives as environment variables set by Pulumi, so a missing or
//! malformed value is a deployment that should not start rather than a request
//! that fails later. The one exception is Telegram, which is absent whenever
//! nobody wants notifying.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};

/// How often aria2 is asked what it is doing while a page is open. One tick is
/// one RPC and one render for the whole process regardless of how many pages
/// there are (see `poll`), and only rows that changed go down a stream, so
/// what this really buys is aria2's own CPU: it serialises the file list of
/// every download it knows about on every call, and that is the part no amount
/// of diffing removes.
///
/// Ten a second reads as continuous — a rate and a byte count move faster than
/// anyone can follow, which is the whole complaint against once a second — and
/// leaves the headroom to go further. Turn it up here rather than guessing:
/// the ceiling is whichever of aria2's CPU or the browser's morph gives first,
/// and which one that is depends on how many downloads are in the list.
const DEFAULT_POLL_MS: u64 = 100;

/// The rate with nobody watching, which is the notifier's alone — it is
/// looking for a download that finished or failed, and nothing about that is
/// in a hurry. Every page closed is a process doing this and nothing else.
const DEFAULT_IDLE_POLL_MS: u64 = 5_000;

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
    pub poll_interval: Duration,
    pub idle_poll_interval: Duration,
}

fn var(key: &str) -> Result<String> {
    std::env::var(key).with_context(|| format!("{key} is not set"))
}

fn var_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

/// A duration in milliseconds, refused rather than defaulted when it is set to
/// something that is not one: this is the knob the poll rate is tuned with, and
/// a typo silently reverting to the default is how a tuning session concludes
/// that nothing it tried made any difference.
fn millis_or(key: &str, default: u64) -> Result<Duration> {
    parse_millis(key, std::env::var(key).ok().as_deref(), default)
}

/// Split from [`millis_or`] so the refusals are testable without setting a
/// process-wide environment variable out from under every other test.
fn parse_millis(key: &str, raw: Option<&str>, default: u64) -> Result<Duration> {
    let ms = match raw {
        Some(raw) => raw
            .parse()
            .with_context(|| format!("{key} must be a whole number of milliseconds"))?,
        None => default,
    };
    if ms == 0 {
        bail!("{key} must be greater than zero");
    }
    Ok(Duration::from_millis(ms))
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
            poll_interval: millis_or("POLL_MS", DEFAULT_POLL_MS)?,
            idle_poll_interval: millis_or("IDLE_POLL_MS", DEFAULT_IDLE_POLL_MS)?,
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
impl Config {
    /// A blank config for tests to fill in the one or two fields they are
    /// about. Every field has to be named somewhere; naming them in four test
    /// modules is how adding one becomes four unrelated edits.
    pub(crate) fn fixture() -> Self {
        Config {
            bind_addr: String::new(),
            aria2_rpc_url: String::new(),
            roots: Vec::new(),
            public_url: String::new(),
            oidc: Oidc {
                issuer: String::new(),
                client_id: String::new(),
                client_secret: String::new(),
            },
            telegram: None,
            poll_interval: Duration::from_millis(DEFAULT_POLL_MS),
            idle_poll_interval: Duration::from_millis(DEFAULT_IDLE_POLL_MS),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conf(roots: &[(&str, &str)]) -> Config {
        Config {
            roots: roots
                .iter()
                .map(|(n, p)| Root {
                    name: n.to_string(),
                    path: PathBuf::from(p),
                })
                .collect(),
            ..Config::fixture()
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
            c.label(Path::new("/mnt/kontent/movies/2046/disc 1")),
            "movies/2046/disc 1"
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

    /// The knob the poll rate is tuned with. A typo silently reverting to the
    /// default is how a tuning session concludes that nothing it tried made
    /// any difference — and zero is a busy loop against aria2, which is the
    /// one setting there is no reason to allow.
    #[test]
    fn a_poll_interval_is_taken_or_refused_but_never_quietly_defaulted() {
        assert_eq!(
            parse_millis("POLL_MS", Some("33"), 100).unwrap(),
            Duration::from_millis(33)
        );
        assert_eq!(
            parse_millis("POLL_MS", None, 100).unwrap(),
            Duration::from_millis(100)
        );
        assert!(parse_millis("POLL_MS", Some("33ms"), 100).is_err());
        assert!(parse_millis("POLL_MS", Some(""), 100).is_err());
        assert!(parse_millis("POLL_MS", Some("0"), 100).is_err());
    }
}
