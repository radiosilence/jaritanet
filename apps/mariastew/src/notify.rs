//! Telegram, on the two events worth interrupting someone for.
//!
//! The point of leaving the house is not checking a web page to find out
//! whether a download finished. Finishing changes what you can do; failing is
//! arguably worth more, because nothing else will ever tell you. Starting is
//! not worth a message — it reports something you just did.
//!
//! Silent when unconfigured, the way the sing-box notifier is: absent
//! credentials skip rather than fail, so the service runs without Telegram at
//! all. Failures to send are logged and swallowed for the same reason — the
//! download succeeded, and a notification is not worth failing it over.
//!
//! The credentials and the message style are shared with
//! `packages/vpn/scripts/notify-singbox.ts`; the code is not. That is a Pulumi
//! command firing at deploy time when a hash changes, which is the wrong shape
//! for a runtime event.

use std::collections::HashMap;
use std::time::Duration;

use crate::aria2::{Download, Status};
use crate::filter;
use crate::routes::all_downloads;
use crate::state::AppState;

/// How often to poll aria2 for a finished or failed download. The whole point
/// of this is not having to keep a page open, so nothing here is in a hurry.
const WATCH_INTERVAL: Duration = Duration::from_secs(5);

/// Watch aria2 and announce transitions, independently of anyone looking.
///
/// The stream only runs while a page is open, and the whole point is not
/// having to keep one open. So this is a background task rather than something
/// the view does on the side.
///
/// It seeds itself from the first poll rather than announcing what it finds:
/// on a restart everything already finished is still in the queue seeding, and
/// re-announcing all of it is the one behaviour that would make the messages
/// worth muting.
pub fn spawn_watcher(state: AppState) {
    tokio::spawn(async move {
        let mut announced: HashMap<String, bool> = HashMap::new();
        let mut seeded = false;

        loop {
            tokio::time::sleep(WATCH_INTERVAL).await;

            let downloads = match all_downloads(&state).await {
                Ok(d) => d,
                Err(e) => {
                    tracing::warn!(error = %e, "notify: aria2 poll failed, retrying next tick");
                    continue;
                }
            };

            if !seeded {
                for d in &downloads {
                    announced.insert(d.gid.clone(), d.status == Status::Error || d.is_finished());
                }
                seeded = true;
                continue;
            }

            for d in &downloads {
                let already = announced.get(&d.gid).copied().unwrap_or(false);
                let terminal = d.status == Status::Error || d.is_finished();
                if terminal && !already {
                    if d.status == Status::Error {
                        let error = d.error_message.as_deref().unwrap_or("unknown error");
                        failed(&state, d.name(), error).await;
                    } else {
                        sweep_garbage(&state, d).await;
                        finished(&state, d.name(), &d.dir).await;
                    }
                }
                announced.insert(d.gid.clone(), terminal);
            }

            // `tellStopped` is a bounded window, so a download eventually
            // falls out of it — forget it too, rather than growing forever.
            let live: HashMap<&str, ()> = downloads.iter().map(|d| (d.gid.as_str(), ())).collect();
            announced.retain(|gid, _| live.contains_key(gid.as_str()));
        }
    });
}

/// Deletes the deselected garbage that landed anyway. aria2 downloads whole
/// pieces regardless of `select-file`, so a small deselected file sharing a
/// piece boundary with a selected one still reaches disk — `#260` anticipated
/// exactly this and left it as a line of code rather than a design change.
/// `--file-allocation=none` (see the README) prevents preallocation, not
/// this.
///
/// A file is removed only when it is both deselected *and*
/// `filter::is_garbage` — never a selected file no matter how it scores, and
/// never a small file that merely happens to be small. Every path still goes
/// through `resolve_existing` immediately before the delete, the same
/// containment check `routes::delete_partial` uses: a path aria2 reports is
/// still a path this process is about to unlink.
async fn sweep_garbage(state: &AppState, d: &Download) {
    for f in &d.files {
        if f.selected || !filter::is_garbage(&f.path) {
            continue;
        }
        if state.config.resolve_existing(&f.path).await.is_none() {
            tracing::warn!(
                path = %f.path,
                "refusing to delete a deselected garbage file outside any root"
            );
            continue;
        }
        if let Err(e) = tokio::fs::remove_file(&f.path).await {
            tracing::warn!(path = %f.path, error = %e, "failed to delete deselected garbage file");
            continue;
        }
        tracing::info!(
            gid = %d.gid,
            path = %f.path,
            "removed deselected garbage left by a piece boundary"
        );
        let _ = tokio::fs::remove_file(format!("{}.aria2", f.path)).await;
    }
}

/// Escape what Telegram's HTML parse mode treats as markup. `&` first, or the
/// entities this just wrote for `<` and `>` get escaped a second time.
pub fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

async fn send(state: &AppState, text: &str) {
    let Some(telegram) = &state.config.telegram else {
        return;
    };
    let url = format!(
        "https://api.telegram.org/bot{}/sendMessage",
        telegram.bot_token
    );
    let body = serde_json::json!({
        "chat_id": telegram.chat_id,
        "text": text,
        "parse_mode": "HTML",
    });
    if let Err(e) = state.http.post(&url).json(&body).send().await {
        tracing::warn!(error = %e, "failed to send telegram notification");
    }
}

/// Name, and where it landed — the second half is what makes it watchable.
pub async fn finished(state: &AppState, name: &str, dir: &str) {
    let text = format!("<b>{}</b>\nfinished — {}", esc(name), esc(dir));
    send(state, &text).await;
}

pub async fn failed(state: &AppState, name: &str, error: &str) {
    let text = format!("<b>{}</b>\nfailed — {}", esc(name), esc(error));
    send(state, &text).await;
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::aria2::{Aria2, File};
    use crate::auth::session::Sessions;
    use crate::config::{Config, Oidc, Root};

    fn file(index: u32, path: &str, selected: bool) -> File {
        File {
            index,
            path: path.to_string(),
            length: 100,
            selected,
        }
    }

    fn download(files: Vec<File>) -> Download {
        Download {
            gid: "gid1".to_string(),
            status: Status::Complete,
            total_length: 100,
            completed_length: 100,
            download_speed: 0,
            upload_speed: 0,
            connections: 0,
            num_seeders: 0,
            error_message: None,
            dir: String::new(),
            files,
            bittorrent_name: None,
            followed_by: Vec::new(),
        }
    }

    fn state(root: std::path::PathBuf) -> AppState {
        AppState {
            config: Arc::new(Config {
                bind_addr: String::new(),
                aria2_rpc_url: String::new(),
                roots: vec![Root {
                    name: "media".to_string(),
                    path: root,
                }],
                public_url: String::new(),
                oidc: Oidc {
                    issuer: String::new(),
                    client_id: String::new(),
                    client_secret: String::new(),
                },
                telegram: None,
            }),
            aria2: Aria2::new(String::new(), reqwest::Client::new()),
            sessions: Sessions::new(),
            http: reqwest::Client::new(),
        }
    }

    /// The bug this exists to fix: a torrent completes with garbage files
    /// aria2 wrote anyway (piece-boundary spillover, not a selection
    /// mistake), and until this ran they just sat there. A selected file and
    /// a deselected-but-not-garbage file (e.g. a `.txt` `filter::is_garbage`
    /// does not flag) must both survive — this is not "delete whatever is
    /// unselected", only what is unselected *and* garbage.
    #[tokio::test]
    async fn sweep_garbage_removes_only_deselected_garbage_inside_a_root() {
        let root = std::env::temp_dir().join("mariastew-sweep-test-inside-root");
        tokio::fs::create_dir_all(&root).await.unwrap();
        let movie = root.join("movie.mkv");
        let cover = root.join("cover.jpg");
        let cover_control = root.join("cover.jpg.aria2");
        let notes = root.join("notes.txt");
        tokio::fs::write(&movie, b"video").await.unwrap();
        tokio::fs::write(&cover, b"jpeg").await.unwrap();
        tokio::fs::write(&cover_control, b"partial").await.unwrap();
        tokio::fs::write(&notes, b"not garbage per filter.rs")
            .await
            .unwrap();

        let d = download(vec![
            file(1, movie.to_str().unwrap(), true),
            file(2, cover.to_str().unwrap(), false),
            file(3, notes.to_str().unwrap(), false),
        ]);
        sweep_garbage(&state(root.clone()), &d).await;

        assert!(movie.exists(), "a selected file must never be removed");
        assert!(
            notes.exists(),
            "a deselected file that is not garbage must survive"
        );
        assert!(!cover.exists(), "deselected garbage must be removed");
        assert!(
            !cover_control.exists(),
            "the .aria2 control file must go with it"
        );

        let _ = tokio::fs::remove_dir_all(&root).await;
    }

    /// The containment boundary applies here exactly as it does to every
    /// other delete in the service: a path aria2 reports is still just a
    /// report, re-checked against the canonicalised roots before anything is
    /// unlinked. A garbage, deselected file sitting outside every configured
    /// root must be left alone even though every other condition for
    /// deletion is met.
    #[tokio::test]
    async fn sweep_garbage_refuses_a_path_outside_every_root() {
        let root = std::env::temp_dir().join("mariastew-sweep-test-root-only");
        let outside = std::env::temp_dir().join("mariastew-sweep-test-outside.jpg");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::write(&outside, b"jpeg").await.unwrap();

        let d = download(vec![file(1, outside.to_str().unwrap(), false)]);
        sweep_garbage(&state(root.clone()), &d).await;

        assert!(
            outside.exists(),
            "a path outside every configured root must never be deleted"
        );

        let _ = tokio::fs::remove_dir_all(&root).await;
        let _ = tokio::fs::remove_file(&outside).await;
    }

    #[test]
    fn esc_escapes_all_three_markup_characters() {
        assert_eq!(
            esc("<b>Tom & Jerry</b>"),
            "&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;"
        );
    }

    /// Escaping `&` first means the entities this just produced for `<` and
    /// `>` never get run back through the `&` replacement.
    #[test]
    fn esc_does_not_double_escape_the_entities_it_just_wrote() {
        assert_eq!(esc("<"), "&lt;");
        assert_eq!(esc(">"), "&gt;");
    }
}
