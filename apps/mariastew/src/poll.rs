//! One poll of aria2 for the whole process, rendered once for everyone.
//!
//! aria2 has no notification for byte-level progress, so the only way to show
//! a moving bar is to ask. How often that can be asked is the question this
//! module exists to answer, and the answer used to be "once a second", because
//! the asking was per open page: every stream ran its own three RPC calls and
//! its own render, so the cost of going faster was multiplied by however many
//! tabs happened to be open, and the cost of a phone left on a bedside table
//! was the same as one being watched.
//!
//! Here it is one task. The RPC and the render happen once per tick no matter
//! how many people are looking, which is what makes the rate a thing that can
//! be turned up at all — and nobody looking is a case worth having, so a
//! process with no viewers falls back to sampling for the notifier's benefit
//! alone (`IDLE_POLL_MS`) and renders nothing.
//!
//! What reaches a viewer is diffed, because at this rate resending the list is
//! the expensive part rather than producing it. Every row is hashed as it is
//! rendered; a stream sends only the rows whose hash moved since the copy it
//! last sent. A seeding torrent is bytes on the wire exactly once.

use std::hash::{DefaultHasher, Hash as _, Hasher as _};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use askama::Template;
use tokio::sync::{Notify, watch};

use crate::aria2::Download;
use crate::routes::all_downloads;
use crate::state::AppState;
use crate::views;

/// One row's markup and a hash of it, so a stream can tell whether the copy it
/// last sent is still current without holding on to the string to compare.
pub struct RenderedRow {
    pub gid: String,
    pub hash: u64,
    pub html: Arc<str>,
}

/// The list as markup: every row on its own, and the container holding all of
/// them. Both, because morphing by id can neither add an element nor remove
/// one — a download appearing or disappearing is the one change that needs the
/// whole container, and every other change needs only a row.
pub struct View {
    pub rows: Vec<RenderedRow>,
    pub full: Arc<str>,
}

/// What one poll saw.
pub struct Snapshot {
    pub downloads: Arc<Vec<Download>>,
    /// `None` when there was nobody to render for, and on the rare tick a
    /// render fails. A viewer treats both the same way — wait for the next
    /// one — because for a viewer they are the same thing.
    pub view: Option<View>,
}

/// The handle the rest of the process reads the queue through.
#[derive(Clone)]
pub struct Poll {
    tx: Arc<watch::Sender<Arc<Snapshot>>>,
    viewers: Arc<AtomicUsize>,
    /// Fired when a viewer arrives, so the poller drops out of an idle sleep
    /// rather than making them sit out the rest of it.
    woken: Arc<Notify>,
}

impl Poll {
    pub fn new() -> Self {
        let (tx, _) = watch::channel(Arc::new(Snapshot {
            downloads: Arc::new(Vec::new()),
            view: None,
        }));
        Self {
            tx: Arc::new(tx),
            viewers: Arc::new(AtomicUsize::new(0)),
            woken: Arc::new(Notify::new()),
        }
    }

    /// Every snapshot from the next one on, without asking for a render. What
    /// the notifier watches: it reads downloads, never markup, and its
    /// interest is not what makes a page smooth.
    pub fn subscribe(&self) -> watch::Receiver<Arc<Snapshot>> {
        self.tx.subscribe()
    }

    /// Whether anyone has a page open, which is the only input to how hard
    /// the poller works.
    pub fn watched(&self) -> bool {
        self.viewers.load(Ordering::Relaxed) > 0
    }

    /// Registering as a viewer is what makes the poller sample at the page's
    /// rate and render what it finds; dropping the guard is what lets it fall
    /// back to idle. So an open page is the entire input to how hard this
    /// works, and closing the last one is noticed within a tick.
    pub fn viewer(&self) -> Viewer {
        self.viewers.fetch_add(1, Ordering::Relaxed);
        self.woken.notify_one();
        Viewer {
            rx: self.tx.subscribe(),
            viewers: Arc::clone(&self.viewers),
        }
    }
}

/// One open page. Dropping it is how the count comes back down, so it has to
/// live inside the stream rather than beside it.
pub struct Viewer {
    rx: watch::Receiver<Arc<Snapshot>>,
    viewers: Arc<AtomicUsize>,
}

impl Viewer {
    /// The next snapshot, skipping any this one was too slow to collect —
    /// which is why a stream diffs against what it last sent rather than
    /// against the previous tick. `None` once the poller is gone.
    pub async fn next(&mut self) -> Option<Arc<Snapshot>> {
        self.rx.changed().await.ok()?;
        Some(self.rx.borrow_and_update().clone())
    }
}

impl Drop for Viewer {
    fn drop(&mut self) {
        self.viewers.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Sample aria2 forever, at the page's rate while anyone is watching and at
/// the notifier's while nobody is.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        loop {
            let watched = state.poll.watched();
            if watched {
                tokio::time::sleep(state.config.poll_interval).await;
            } else {
                tokio::select! {
                    _ = tokio::time::sleep(state.config.idle_poll_interval) => {}
                    _ = state.poll.woken.notified() => {}
                }
            }

            let downloads = match all_downloads(&state).await {
                Ok(d) => d,
                Err(e) => {
                    tracing::warn!(error = %e, "poll: aria2 poll failed, retrying next tick");
                    continue;
                }
            };
            let view = watched.then(|| render(&state, &downloads)).flatten();
            let _ = state.poll.tx.send(Arc::new(Snapshot {
                downloads: Arc::new(downloads),
                view,
            }));
        }
    });
}

/// Every row rendered on its own and the container rendered around them. The
/// container costs a second pass over the same rows, which is worth the
/// alternative not being a template: it is the markup of the list, and the
/// list's markup belongs in `downloads.html` rather than in a `format!` here.
fn render(state: &AppState, downloads: &[Download]) -> Option<View> {
    let rows = crate::routes::rows(state, downloads);
    let rendered: Result<Vec<_>, _> = rows
        .iter()
        .map(|row| {
            (views::RowMarkup { row }).render().map(|html| RenderedRow {
                gid: row.gid.clone(),
                hash: hash(&html),
                html: html.into(),
            })
        })
        .collect();
    let full = views::Downloads { rows }.render();
    match (rendered, full) {
        (Ok(rows), Ok(full)) => Some(View {
            rows,
            full: full.into(),
        }),
        (Err(e), _) | (_, Err(e)) => {
            tracing::error!(error = %e, "poll: template render failed, retrying next tick");
            None
        }
    }
}

fn hash(html: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    html.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole cost model: an open page is what makes this sample fast, and
    /// the last one closing is what lets it stop. A guard that leaked would
    /// leave a process polling ten times a second at nobody, forever.
    #[test]
    fn a_page_opening_and_closing_is_what_moves_the_rate() {
        let poll = Poll::new();
        assert!(!poll.watched());

        let one = poll.viewer();
        let two = poll.viewer();
        assert!(poll.watched());

        drop(one);
        assert!(poll.watched(), "one page closing is not every page closing");
        drop(two);
        assert!(!poll.watched());
    }

    fn state() -> AppState {
        AppState {
            config: Arc::new(crate::config::Config::fixture()),
            aria2: crate::aria2::Aria2::new(String::new(), reqwest::Client::new()),
            sessions: crate::auth::session::Sessions::new(),
            activity: crate::activity::Activity::new(),
            clearing: crate::state::Clearing::default(),
            poll: Poll::new(),
            http: reqwest::Client::new(),
        }
    }

    /// What makes sending a row instead of the list a saving rather than a
    /// second rendering of the same screen: the row a stream pushes is
    /// byte-for-byte the row the container holds, from the one template. Two
    /// files drifting apart would show as a row that flickers between two
    /// renderings of itself every time the membership changes.
    #[test]
    fn a_pushed_row_is_the_row_the_container_holds() {
        let downloads = vec![
            Download {
                gid: "first".to_string(),
                ..Download::fixture()
            },
            Download {
                gid: "second".to_string(),
                total_length: 1000,
                completed_length: 250,
                download_speed: 100,
                ..Download::fixture()
            },
        ];
        let view = render(&state(), &downloads).expect("both rows render");

        assert_eq!(
            view.rows.iter().map(|r| &r.gid).collect::<Vec<_>>(),
            ["first", "second"]
        );
        for row in &view.rows {
            assert!(
                view.full.contains(row.html.as_ref()),
                "row {} is rendered differently on its own than in the list",
                row.gid
            );
        }
    }

    /// The diff is only worth anything if identical state hashes identically
    /// and a moved byte counter does not.
    #[test]
    fn a_rows_hash_follows_what_it_says_and_nothing_else() {
        let state = state();
        let quiet = vec![Download::fixture()];
        let moved = vec![Download {
            completed_length: 512,
            total_length: 1024,
            ..Download::fixture()
        }];

        let a = render(&state, &quiet).unwrap();
        let b = render(&state, &quiet).unwrap();
        let c = render(&state, &moved).unwrap();

        assert_eq!(a.rows[0].hash, b.rows[0].hash);
        assert_ne!(a.rows[0].hash, c.rows[0].hash);
    }
}
