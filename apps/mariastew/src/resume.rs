//! The adds nobody is finishing, finished.
//!
//! Adding a magnet is two steps with a gap in the middle: aria2 resolves the
//! metadata and creates the real download paused (`--pause-metadata`), and
//! `routes::finish_add` — detached from the request that asked for it — reads
//! the file list, narrows it to what is worth keeping, and releases it. The
//! second step lives in one process's memory and nothing restores it, so a pod
//! replaced inside the gap leaves a download aria2 will hold, paused, forever.
//!
//! That is not a rare window. It is every add, for as long as a magnet takes
//! to resolve, and a resolve is minutes on a sparse swarm.
//!
//! **An unfinished add is a paused download with no `select-file`.** aria2
//! holds that mark, `routes::finish_add_inner` writes it exactly once at the
//! end of the sequence, and nothing else writes it at all — so its absence is
//! the difference between a download waiting to be finished and one somebody
//! deliberately paused, without inferring anything from names or byte counts.
//!
//! Two earlier rules for this were wrong, and both failed the same way:
//!
//! - *A `[METADATA]` row at startup.* `--bt-load-saved-metadata` means a
//!   restored magnet has its torrent read off the disk before aria2 answers a
//!   single RPC, so what comes back is named after the file rather than
//!   `[METADATA]…` and the rule matched nothing. The two fixes cancelled out.
//! - *Only the first poll.* A magnet that resolves a minute after start-up
//!   produces its paused child a minute after start-up, and a one-shot at
//!   boot has long since run.
//!
//! So this reconciles continuously, off the snapshots the poller already
//! publishes. It costs one `getOption` per paused download per tick, and only
//! paused ones — a queue that is running asks aria2 nothing extra.

use std::sync::Arc;

use crate::aria2::{Download, Status};
use crate::routes::finish_add_inner;
use crate::state::AppState;

/// Watches the poll for downloads with nobody finishing them.
///
/// Reading the poller rather than aria2 directly is also how this waits for
/// the sidecar — only a successful sample is ever published — and it means an
/// aria2 that restarts under a still-running mariastew is reconciled too,
/// which a start-up hook could never see.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut poll = state.poll.subscribe();
        while poll.changed().await.is_ok() {
            let downloads = poll.borrow_and_update().downloads.clone();
            reconcile(&state, &downloads).await;
        }
    });
}

async fn reconcile(state: &AppState, downloads: &Arc<Vec<Download>>) {
    for d in downloads.iter() {
        if d.status != Status::Paused || state.adding.contains(&d.gid) {
            continue;
        }
        match state.aria2.has_selection(&d.gid).await {
            // Someone pressed pause. Theirs to undo.
            Ok(true) => continue,
            Ok(false) => {}
            Err(e) => {
                tracing::warn!(gid = %d.gid, error = %e, "resume: could not read the selection");
                continue;
            }
        }
        tokio::spawn(adopt(state.clone(), d.gid.clone(), d.dir.clone()));
    }
}

/// One unfinished add, carried the rest of the way.
///
/// The claim is taken here rather than left to `finish_add_inner`, because the
/// gap between spawning this and that function reaching its own claim is a gap
/// the next tick can arrive in — and two tasks narrowing one download would
/// race to release it.
///
/// The release comes first and is fatal to this attempt if it fails: a paused
/// magnet fetches no metadata, so there would be nothing for the finish below
/// to wait for and it would spend ten minutes proving it. `sub` is the audit
/// field on the "starting download" line, and nobody asked for this one — the
/// restart did.
async fn adopt(state: AppState, gid: String, dir: String) {
    let claim = state.adding.claim(&gid);
    tracing::info!(%gid, %dir, "resume: finishing an add nobody was finishing");
    state
        .activity
        .record(&gid, "picked up again after a restart");

    if let Err(e) = state.aria2.unpause(&gid).await {
        tracing::error!(%gid, error = %e, "resume: could not release a stalled add");
        state.activity.record(&gid, format!("failed — {e}"));
        return;
    }

    // Dropped before the finish rather than held across it: `finish_add_inner`
    // takes its own claim on the same gid, and this one has done its job the
    // moment that exists.
    drop(claim);

    if let Err(e) = finish_add_inner(&state, "restart", &dir, &gid).await {
        tracing::error!(%gid, error = %e, "resume: could not finish an interrupted add");
        state.activity.record(&gid, format!("failed — {e}"));
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use axum::extract::State as AxumState;
    use axum::routing::post;
    use axum::{Json, Router};

    use super::*;
    use crate::config::Config;

    #[derive(Clone)]
    struct Mock {
        unpaused: Arc<Mutex<Vec<String>>>,
        selected: Arc<Mutex<Vec<String>>>,
        /// Whether the paused download in the queue already carries a
        /// selection — the difference between an abandoned add and one
        /// somebody paused on purpose.
        has_selection: bool,
        /// Whether the adopted gid still has a metadata pass to be followed to
        /// its download, or *is* that download already — see `routes::follow`.
        resolves_to_child: bool,
    }

    /// A download paused with no selection, exactly as a restart leaves one.
    /// Named after its file rather than `[METADATA]…`, because
    /// `--bt-load-saved-metadata` resolves it off the disk before aria2 answers
    /// anything — which is the shape the old rule missed.
    async fn mock_aria2(mock: Mock) -> String {
        async fn rpc(
            AxumState(mock): AxumState<Mock>,
            Json(body): Json<serde_json::Value>,
        ) -> Json<serde_json::Value> {
            let gid = body["params"][0].as_str().unwrap_or_default().to_string();
            // aria2 reports a released download as running, so the mock has to
            // as well: `finish_add_inner` reads the status back to decide
            // whether there is a pause left to undo, and a mock frozen at
            // "paused" would let a double release through unnoticed.
            let released = |g: &str| mock.unpaused.lock().unwrap().iter().any(|u| u == g);
            let live = |g: &str| if released(g) { "active" } else { "paused" };
            let result = match body["method"].as_str().unwrap_or_default() {
                "aria2.tellActive" | "aria2.tellStopped" => serde_json::json!([]),
                "aria2.tellWaiting" => serde_json::json!([download(
                    "stranded-gid",
                    live("stranded-gid"),
                    serde_json::json!([{"index": "1", "path": "/tv/Show.S01/ep01.mkv", "length": "90", "selected": "true"}]),
                )]),
                "aria2.getOption" => {
                    if mock.has_selection {
                        serde_json::json!({"select-file": "1"})
                    } else {
                        serde_json::json!({"dir": "/tv"})
                    }
                }
                "aria2.tellStatus" if gid == "child-gid" => download(
                    "child-gid",
                    live("child-gid"),
                    serde_json::json!([
                        {"index": "1", "path": "/tv/Show.S01/poster.jpg", "length": "10", "selected": "true"},
                        {"index": "2", "path": "/tv/Show.S01/ep01.mkv", "length": "90", "selected": "true"},
                    ]),
                ),
                "aria2.tellStatus" if mock.resolves_to_child => {
                    let mut d = download("stranded-gid", "active", serde_json::json!([]));
                    d["followedBy"] = serde_json::json!(["child-gid"]);
                    d
                }
                // No `followedBy`, and not a `[METADATA]` row: the torrent was
                // read off the disk during aria2's start-up, so this gid is
                // the download itself.
                "aria2.tellStatus" => download(
                    "stranded-gid",
                    live("stranded-gid"),
                    serde_json::json!([
                        {"index": "1", "path": "/tv/Show.S01/poster.jpg", "length": "10", "selected": "true"},
                        {"index": "2", "path": "/tv/Show.S01/ep01.mkv", "length": "90", "selected": "true"},
                    ]),
                ),
                "aria2.unpause" => {
                    mock.unpaused.lock().unwrap().push(gid.clone());
                    serde_json::json!(gid)
                }
                "aria2.pause" => panic!("the add must not pause anything itself any more"),
                "aria2.changeOption" => {
                    if let Some(files) = body["params"][1]["select-file"].as_str() {
                        mock.selected.lock().unwrap().push(files.to_string());
                    }
                    serde_json::json!("OK")
                }
                other => panic!("unexpected aria2 method in test: {other}"),
            };
            Json(serde_json::json!({"jsonrpc": "2.0", "id": "mariastew", "result": result}))
        }

        fn download(gid: &str, status: &str, files: serde_json::Value) -> serde_json::Value {
            serde_json::json!({
                "gid": gid,
                "status": status,
                "totalLength": "100",
                "completedLength": "0",
                "downloadSpeed": "0",
                "uploadSpeed": "0",
                "connections": "0",
                "dir": "/tv",
                "files": files,
            })
        }

        let app = Router::new().route("/", post(rpc)).with_state(mock);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}/")
    }

    fn state_for(url: String) -> AppState {
        let http = reqwest::Client::new();
        AppState {
            config: Arc::new(Config {
                aria2_rpc_url: url.clone(),
                // The poller samples on the idle schedule with nobody
                // watching, and this test is the nobody.
                idle_poll_interval: Duration::from_millis(10),
                ..Config::fixture()
            }),
            aria2: crate::aria2::Aria2::new(url, http.clone()),
            sessions: crate::auth::session::Sessions::new(),
            poll: crate::poll::Poll::new(),
            activity: crate::activity::Activity::new(),
            clearing: crate::state::Clearing::default(),
            adding: crate::state::Adding::default(),
            http,
        }
    }

    async fn settle(f: impl Fn() -> bool) -> bool {
        for _ in 0..200 {
            if f() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        false
    }

    /// The whole bug, end to end — and the one the first version of this
    /// missed. A restart leaves a paused download that nothing in aria2 will
    /// ever start, and because `--bt-load-saved-metadata` resolves it off the
    /// disk it does *not* come back looking like a metadata row. Adopting it
    /// has to both release it and apply the selection the interrupted add
    /// never got to: coming back downloading everything is a different
    /// failure, not a fix.
    #[tokio::test]
    async fn a_paused_add_with_no_selection_is_released_and_narrowed() {
        let mock = Mock {
            unpaused: Arc::new(Mutex::new(Vec::new())),
            selected: Arc::new(Mutex::new(Vec::new())),
            has_selection: false,
            resolves_to_child: true,
        };
        let state = state_for(mock_aria2(mock.clone()).await);

        crate::poll::spawn(state.clone());
        spawn(state.clone());

        assert!(
            settle(|| !mock.selected.lock().unwrap().is_empty()).await,
            "the stranded add was never picked up"
        );
        assert_eq!(
            *mock.unpaused.lock().unwrap(),
            ["stranded-gid", "child-gid"],
            "the stalled add has to be released before it resolves, and the \
             download it resolves to released again after being narrowed"
        );
        assert_eq!(
            *mock.selected.lock().unwrap(),
            ["2"],
            "the poster is what the filter exists to leave behind"
        );
    }

    /// The other half of the rule, and the reason it is `select-file` rather
    /// than "is it paused". Someone pressing pause and then a deploy landing
    /// must not read as an abandoned add — a queue that quietly restarts
    /// itself on every deploy is its own bug.
    #[tokio::test]
    async fn a_download_somebody_paused_on_purpose_is_left_alone() {
        let mock = Mock {
            unpaused: Arc::new(Mutex::new(Vec::new())),
            selected: Arc::new(Mutex::new(Vec::new())),
            has_selection: true,
            resolves_to_child: false,
        };
        let state = state_for(mock_aria2(mock.clone()).await);

        crate::poll::spawn(state.clone());
        spawn(state.clone());

        assert!(
            !settle(|| !mock.unpaused.lock().unwrap().is_empty()).await,
            "a deliberate pause was overruled"
        );
    }

    /// The shape production actually restores, and the one the first version
    /// of this got wrong twice over. `--bt-load-saved-metadata` reads the
    /// torrent off the disk during aria2's start-up, so the adopted gid has no
    /// metadata pass left to follow and no `followedBy` that will ever appear
    /// — waiting for one is ten minutes of polling and a timeout, with the
    /// download running unnarrowed throughout.
    #[tokio::test]
    async fn an_add_restored_past_its_metadata_pass_is_narrowed_in_place() {
        let mock = Mock {
            unpaused: Arc::new(Mutex::new(Vec::new())),
            selected: Arc::new(Mutex::new(Vec::new())),
            has_selection: false,
            resolves_to_child: false,
        };
        let state = state_for(mock_aria2(mock.clone()).await);

        crate::poll::spawn(state.clone());
        spawn(state.clone());

        assert!(
            settle(|| !mock.selected.lock().unwrap().is_empty()).await,
            "an add with no metadata pass left to follow was never narrowed"
        );
        assert_eq!(*mock.selected.lock().unwrap(), ["2"]);
        assert_eq!(
            *mock.unpaused.lock().unwrap(),
            ["stranded-gid"],
            "there is one download here, so there is one release"
        );
    }

    /// The reconciler runs every tick and an add takes seconds, so the state
    /// it recognises is one a live add stands in the middle of. Without the
    /// claim it would adopt the add already running beside it.
    #[tokio::test]
    async fn an_add_this_process_is_already_running_is_not_adopted() {
        let mock = Mock {
            unpaused: Arc::new(Mutex::new(Vec::new())),
            selected: Arc::new(Mutex::new(Vec::new())),
            has_selection: false,
            resolves_to_child: true,
        };
        let state = state_for(mock_aria2(mock.clone()).await);
        let _claim = state.adding.claim("stranded-gid");

        crate::poll::spawn(state.clone());
        spawn(state.clone());

        assert!(
            !settle(|| !mock.unpaused.lock().unwrap().is_empty()).await,
            "the reconciler raced the add that was already in flight"
        );
    }
}
