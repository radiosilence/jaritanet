//! The adds a restart interrupted, picked up again.
//!
//! Adding a magnet is two steps with a gap in the middle: aria2 resolves the
//! metadata, and `routes::finish_add` — detached from the request that asked
//! for it — waits for the download that comes out of that, narrows it to the
//! files worth keeping, and starts it. A pod replaced inside the gap loses the
//! second step alone, because aria2's session restores the first.
//!
//! What comes back is worse than nothing. The narrowing is done under a pause,
//! aria2 serialises `pause=true` alongside the magnet, and a restored paused
//! magnet does not even ask for metadata — so the row says "finding peers"
//! over data that may already be complete, and says it forever. That is the
//! shape of "the queue came back but nothing in it moves".
//!
//! A metadata download still in aria2's active or waiting queues when this
//! process starts is exactly one of those: an add with nobody finishing it.
//! Nothing else leaves one there — once a magnet resolves, its own gid moves
//! to the stopped list, which `routes::all_downloads` already sweeps. So they
//! are adopted, once, and put through the same finish the request would have.
//!
//! Deliberately only at startup. A metadata row on screen carries a pause
//! button like any other, so unpausing one on sight would be overruling
//! someone who pressed it a second ago; one that was already paused before
//! this process existed is not that.

use crate::aria2::Status;
use crate::routes::finish_add_inner;
use crate::state::AppState;

/// Whatever the first poll finds. Waiting on the poller rather than asking
/// aria2 directly is also how this waits for the sidecar: only a successful
/// sample is ever published, and aria2 loads its session before it answers RPC
/// at all, so a first answer is a complete one.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut poll = state.poll.subscribe();
        if poll.changed().await.is_err() {
            return;
        }
        let downloads = poll.borrow_and_update().downloads.clone();
        for d in downloads.iter().filter(|d| d.is_metadata()) {
            tokio::spawn(adopt(
                state.clone(),
                d.gid.clone(),
                d.dir.clone(),
                d.status == Status::Paused,
            ));
        }
    });
}

/// One interrupted add, carried the rest of the way.
///
/// The unpause comes first and is fatal to this attempt if it fails: the whole
/// point is that a paused magnet fetches no metadata, so there is nothing for
/// the finish below to wait for and it would only spend ten minutes proving
/// it. `sub` is the audit field on the "starting download" line, and nobody
/// asked for this one — the restart did.
async fn adopt(state: AppState, gid: String, dir: String, paused: bool) {
    tracing::info!(%gid, %dir, paused, "resume: finishing an add a restart interrupted");
    state
        .activity
        .record(&gid, "picked up again after a restart");

    if paused && let Err(e) = state.aria2.unpause(&gid).await {
        tracing::error!(%gid, error = %e, "resume: could not restart a paused add");
        state.activity.record(&gid, format!("failed — {e}"));
        return;
    }

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

    #[derive(Clone, Default)]
    struct Calls {
        unpaused: Arc<Mutex<Vec<String>>>,
        selected: Arc<Mutex<Vec<String>>>,
    }

    /// A restored add exactly as aria2 hands one back: the magnet's own gid,
    /// paused, in the waiting queue, with the download it resolved to already
    /// attached. The child's file list is the one the filter has to see —
    /// reading the metadata gid's own would find a single `[METADATA]` entry
    /// and select by position (see `finish_add_inner`).
    async fn mock_aria2(calls: Calls) -> String {
        async fn rpc(
            AxumState(calls): AxumState<Calls>,
            Json(body): Json<serde_json::Value>,
        ) -> Json<serde_json::Value> {
            let gid = body["params"][0].as_str().unwrap_or_default().to_string();
            let result = match body["method"].as_str().unwrap_or_default() {
                "aria2.tellActive" | "aria2.tellStopped" => serde_json::json!([]),
                "aria2.tellWaiting" => serde_json::json!([download(
                    "metadata-gid",
                    "paused",
                    serde_json::json!([{"index": "1", "path": "[METADATA]Show.S01", "length": "0", "selected": "true"}]),
                )]),
                "aria2.tellStatus" if gid == "child-gid" => download(
                    "child-gid",
                    "active",
                    serde_json::json!([
                        {"index": "1", "path": "/tv/Show.S01/poster.jpg", "length": "10", "selected": "true"},
                        {"index": "2", "path": "/tv/Show.S01/ep01.mkv", "length": "90", "selected": "true"},
                    ]),
                ),
                "aria2.tellStatus" => {
                    let mut d = download("metadata-gid", "complete", serde_json::json!([]));
                    d["followedBy"] = serde_json::json!(["child-gid"]);
                    d
                }
                "aria2.unpause" => {
                    calls.unpaused.lock().unwrap().push(gid.clone());
                    serde_json::json!(gid)
                }
                "aria2.pause" => serde_json::json!(gid),
                "aria2.changeOption" => {
                    if let Some(files) = body["params"][1]["select-file"].as_str() {
                        calls.selected.lock().unwrap().push(files.to_string());
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

        let app = Router::new().route("/", post(rpc)).with_state(calls);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}/")
    }

    /// The whole bug, end to end: a deploy that lands mid-add leaves a paused
    /// magnet in the session, and nothing in aria2 will ever start it again.
    /// Adopting it has to both release the pause and apply the selection the
    /// interrupted add never got to — coming back downloading everything is a
    /// different failure, not a fix.
    #[tokio::test]
    async fn a_paused_add_left_by_a_restart_is_released_and_narrowed() {
        let calls = Calls::default();
        let url = mock_aria2(calls.clone()).await;
        let http = reqwest::Client::new();
        let state = AppState {
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
            http,
        };

        crate::poll::spawn(state.clone());
        spawn(state.clone());

        for _ in 0..200 {
            if !calls.selected.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        assert_eq!(
            *calls.unpaused.lock().unwrap(),
            ["metadata-gid", "child-gid"],
            "the restored magnet has to be released before it fetches anything, \
             and the download it resolves to released again after being narrowed"
        );
        assert_eq!(
            *calls.selected.lock().unwrap(),
            ["2"],
            "the poster is what the filter exists to leave behind"
        );
        assert!(
            state
                .activity
                .entries("child-gid")
                .iter()
                .any(|e| e.message.contains("picked up again after a restart")),
            "the row has to say why it moved on its own"
        );
    }
}
