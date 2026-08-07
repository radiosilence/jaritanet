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

use crate::aria2::Status;
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
    use super::*;

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
