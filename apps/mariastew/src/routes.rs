//! The page, the stream, and the four things the page can ask for.

use std::collections::HashSet;
use std::convert::Infallible;
use std::time::Duration;

use askama::Template;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive};
use axum::response::{Html, IntoResponse, Response, Sse};
use axum::routing::{get, post};
use axum::{Form, Router};
use futures_util::stream;

use crate::aria2::{Download, Status};
use crate::auth::extract::CurrentSession;
use crate::error::{AppError, AppResult};
use crate::filter;
use crate::state::AppState;
use crate::views::{self, DirView, RootView, Row};

/// How often the stream samples aria2. Byte-level progress has no notification
/// to wait for, and once a second is plenty for a handful of downloads watched
/// by one person.
pub const TICK_SECS: u64 = 1;

/// Everything behind the auth layer. Mounted by `main`, which wraps it — see
/// `auth::extract::require_session` for why that is a layer and not a
/// decorator per route.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(page))
        .route("/stream", get(stream))
        .route("/add", post(add))
        .route("/downloads/{gid}/pause", post(pause))
        .route("/downloads/{gid}/resume", post(resume))
        .route("/downloads/{gid}/remove", post(remove))
        .route("/browse", get(browse))
        .route("/mkdir", post(mkdir))
}

/// Every download aria2 knows about, running before queued before finished or
/// errored — the order `page` renders them in, and what `stream` re-fetches
/// every tick and the notify watcher polls to catch a transition.
pub(crate) async fn all_downloads(state: &AppState) -> AppResult<Vec<Download>> {
    let mut downloads = state.aria2.tell_active().await?;
    downloads.extend(state.aria2.tell_waiting(0, 100).await?);
    downloads.extend(state.aria2.tell_stopped(0, 100).await?);
    // `add`'s metadata-only pass exists to learn a magnet's file list before
    // the real download starts (see `free_infohash`) and is gone by the time
    // this runs in the ordinary case — `add` removes it once it has what it
    // needs. aria2 names one `[METADATA]<torrent name>` for as long as it
    // exists, which is how a stray one is told apart from a real download:
    // it is never something the user asked to watch, so if one lingers
    // because a previous `add` died mid-flight, it still must not appear.
    downloads.retain(|d| !is_metadata_row(d));
    Ok(downloads)
}

fn is_metadata_row(d: &Download) -> bool {
    d.name().starts_with("[METADATA]")
}

/// The `data:` payload for a `datastar-patch-elements` event: every line of
/// `html` prefixed with `elements `. Split out from [`patch_elements`] so the
/// prefixing is testable without touching `Event`'s own internals.
fn patch_elements_data(html: &str) -> String {
    html.lines()
        .map(|line| format!("elements {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Push replacement markup down the stream, Datastar's `datastar-patch-elements`
/// event. `axum::response::sse::Event::data` turns an embedded `\n` into a
/// repeated `data:` field, which is what makes the single joined string come out
/// on the wire as one `data: elements ...` line per line of `html`.
///
/// This pushes markup rather than signals because a row changes at the rate of
/// its slowest-changing part: speed, peers and the health colour all move
/// together, so there is no surrounding HTML being re-sent around a lone
/// changing value — the case signals exist to avoid. The client morphs by
/// element id, so only rows that actually changed move; there is no diffing on
/// the server and no client-side state to keep in step with it.
fn patch_elements(html: &str) -> Event {
    Event::default()
        .event("datastar-patch-elements")
        .data(patch_elements_data(html))
}

pub async fn page(State(state): State<AppState>) -> AppResult<Html<String>> {
    // A restarted aria2 sidecar should not blank the whole page: the picker
    // and everything else on it are still useful without a download list, and
    // `stream` will repopulate `#downloads` on its own the moment aria2
    // answers again. Only `add`/`pause`/`resume`/`remove` still propagate the
    // real error — those are asking aria2 to do something, and a silent
    // success there would be the wrong kind of tolerant.
    let (rows, aria2_unreachable) = match all_downloads(&state).await {
        Ok(downloads) => (downloads.iter().map(Row::from).collect(), false),
        Err(e) => {
            tracing::warn!(error = %e, "page: aria2 unreachable, rendering with an empty list");
            (Vec::new(), true)
        }
    };
    let roots = state
        .config
        .roots
        .iter()
        .map(|r| RootView {
            name: r.name.clone(),
            path: r.path.to_string_lossy().into_owned(),
        })
        .collect();
    let page = views::Page {
        roots,
        rows,
        aria2_unreachable,
    };
    let html = page.render().map_err(|e| AppError::Internal(e.into()))?;
    Ok(Html(html))
}

/// One long-lived stream per page. The loop re-reads the session as it ticks:
/// a page left open holds this connection for hours, and nothing else would
/// ever notice the session being revoked underneath it.
pub async fn stream(
    State(state): State<AppState>,
    CurrentSession(session): CurrentSession,
) -> Response {
    let session_id = session.id;
    let s = async_stream::stream! {
        let mut interval = tokio::time::interval(Duration::from_secs(TICK_SECS));
        loop {
            interval.tick().await;

            // A page left open holds this connection for hours; a session
            // revoked in the meantime is never re-checked by anything else,
            // so logging out would otherwise leave a live feed of the queue
            // attached to a browser no longer permitted to see it.
            if state.sessions.get(&session_id).await.is_none() {
                break;
            }

            let downloads = match all_downloads(&state).await {
                Ok(d) => d,
                Err(e) => {
                    tracing::warn!(error = %e, "stream: aria2 poll failed, retrying next tick");
                    continue;
                }
            };
            let rows: Vec<Row> = downloads.iter().map(Row::from).collect();
            let html = match (views::Downloads { rows }).render() {
                Ok(h) => h,
                Err(e) => {
                    tracing::error!(error = %e, "stream: template render failed, retrying next tick");
                    continue;
                }
            };
            yield Ok::<_, Infallible>(patch_elements(&html));
        }
    };

    Sse::new(s).keep_alive(KeepAlive::default()).into_response()
}

#[derive(serde::Deserialize)]
pub struct AddForm {
    pub magnet: String,
    pub dir: String,
}

/// A bare magnet check, not a URI parse — the form only ever needs to tell a
/// magnet link from anything else someone pasted.
fn is_magnet(s: &str) -> bool {
    s.starts_with("magnet:?")
}

/// Metadata first, then the real download with only the wanted files selected.
pub async fn add(
    State(state): State<AppState>,
    CurrentSession(session): CurrentSession,
    Form(form): Form<AddForm>,
) -> AppResult<Response> {
    // Rejected at the boundary rather than handed to aria2 to fail on later.
    // A file upload is a different interface for a case that does not come up
    // on a phone.
    if !is_magnet(&form.magnet) {
        return Err(AppError::BadRequest("magnets only".to_string()));
    }
    let dir = state.config.resolve(&form.dir).ok_or_else(|| {
        AppError::BadRequest("destination is not inside a configured root".to_string())
    })?;
    let dir = dir.to_string_lossy().into_owned();

    let metadata_gid = state
        .aria2
        .add_uri(
            &form.magnet,
            serde_json::json!({"bt-metadata-only": "true", "follow-torrent": "mem"}),
        )
        .await?;

    // `Complete` is what "the metadata has arrived" actually means. Waiting for a
    // non-empty file list instead is racy: aria2 populates `files` slightly
    // before it flips the status, so the pass could still be active when the
    // infohash was freed below — which is how the real download came to be
    // rejected as a duplicate of a download that had not finished letting go.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let files = loop {
        let status = state.aria2.tell_status(&metadata_gid).await?;
        if status.status == Status::Error {
            return Err(AppError::Upstream(
                status
                    .error_message
                    .unwrap_or_else(|| "metadata fetch failed".to_string()),
            ));
        }
        if status.status == Status::Complete {
            break status.files;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(AppError::BadRequest(
                "the magnet did not resolve".to_string(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    };

    let indices: Vec<String> = files
        .iter()
        .filter(|f| !filter::is_garbage(&f.path))
        .map(|f| f.index.to_string())
        .collect();
    if indices.is_empty() {
        return Err(AppError::BadRequest(
            "every file in this torrent is garbage".to_string(),
        ));
    }

    // What the filter kept out, and what that saved. Worth a glance on the
    // first torrent to confirm the selection actually took — a skipped file
    // should never reach the disk at all, and this is the only record that it
    // did not. It is also the audit line for a write endpoint onto the media
    // library: who asked for what, and where it was told to land.
    let (skipped, skipped_bytes) = files
        .iter()
        .filter(|f| filter::is_garbage(&f.path))
        .fold((0u32, 0u64), |(n, b), f| (n + 1, b + f.length));
    tracing::info!(
        sub = %session.sub,
        magnet_files = files.len(),
        wanted = indices.len(),
        skipped,
        skipped_bytes,
        %dir,
        "starting download"
    );

    free_infohash(&state, &metadata_gid).await?;

    state
        .aria2
        .add_uri(
            &form.magnet,
            serde_json::json!({"dir": dir, "select-file": indices.join(",")}),
        )
        .await?;

    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Stop and purge the metadata-only pass so its infohash is free again.
///
/// aria2 refuses to register a second download under an infohash that is
/// still active — the metadata pass above is that download, and it is still
/// registered right up until this runs. Without this, the real `addUri` a
/// few lines below fails every single time with "InfoHash ... is already
/// registered", the metadata's 30KB placeholder is all that ever lands, and
/// nothing the user asked for downloads. `remove` already falls back to
/// `forceRemove` for a download that will not stop cleanly, which is exactly
/// the case here — it is told to stop the instant it has told us what it
/// resolved to, not once it is ready to.
///
/// Both calls are attempted and tolerated individually: depending on how far
/// the metadata pass got on its own, one may already be a no-op. Only if
/// both fail is there no evidence the infohash was actually released, and
/// that is the one case this returns an error for — proceeding to the real
/// `addUri` anyway would be issuing a request already known to be rejected.
async fn free_infohash(state: &AppState, metadata_gid: &str) -> AppResult<()> {
    let removed = state.aria2.remove(metadata_gid).await;
    let purged = state.aria2.remove_download_result(metadata_gid).await;
    match (removed, purged) {
        (Err(remove_err), Err(_)) => Err(AppError::Upstream(format!(
            "could not free the metadata pass ({metadata_gid}) before starting the real download: {remove_err}"
        ))),
        _ => Ok(()),
    }
}

pub async fn pause(State(state): State<AppState>, Path(gid): Path<String>) -> AppResult<Response> {
    state.aria2.pause(&gid).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn resume(State(state): State<AppState>, Path(gid): Path<String>) -> AppResult<Response> {
    state.aria2.unpause(&gid).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Delete a torrent's on-disk remains: every selected file plus its `.aria2`
/// control file, and the subdirectory the torrent made for itself if that
/// leaves it empty. Every path is re-checked through `resolve_existing`
/// immediately before the delete — a path aria2 hands back is still a path
/// this process is about to unlink, `resolve` alone only decides about the
/// name, and this is the one place in the service that destroys anything.
/// Failures are logged, not fatal: the download is already removed from the
/// queue either way.
async fn delete_partial(state: &AppState, status: &Download) {
    let mut dirs = HashSet::new();
    for f in &status.files {
        if state.config.resolve_existing(&f.path).await.is_none() {
            tracing::warn!(path = %f.path, "refusing to delete a path outside any root");
            continue;
        }
        if let Some(parent) = std::path::Path::new(&f.path).parent() {
            dirs.insert(parent.to_path_buf());
        }
        if let Err(e) = tokio::fs::remove_file(&f.path).await {
            tracing::warn!(path = %f.path, error = %e, "failed to delete partial file");
        }
        let _ = tokio::fs::remove_file(format!("{}.aria2", f.path)).await;
    }
    for dir in dirs {
        let Some(dir_str) = dir.to_str() else {
            continue;
        };
        // `status.dir` is the destination the download was added into, not a
        // directory the torrent made for itself — never remove that one.
        if dir_str == status.dir || state.config.resolve_existing(dir_str).await.is_none() {
            continue;
        }
        // Fails silently when the directory is not actually empty, which is
        // the common case for a multi-file torrent with siblings left over.
        let _ = tokio::fs::remove_dir(&dir).await;
    }
}

/// Two behaviours behind one button, decided by whether the download completed.
/// In progress, the partial data goes with it — a half-downloaded episode
/// sitting in the library is the mess this exists to avoid. Finished and
/// seeding, the files stay: that is stopping an upload, not undoing a download,
/// and deleting the episode would be astonishing.
pub async fn remove(
    State(state): State<AppState>,
    CurrentSession(session): CurrentSession,
    Path(gid): Path<String>,
) -> AppResult<Response> {
    let status = state.aria2.tell_status(&gid).await?;
    // The only request that destroys anything, so it says who asked and which
    // of the two meanings applied before it does.
    tracing::info!(
        sub = %session.sub,
        gid = %gid,
        name = %status.name(),
        finished = status.is_finished(),
        "removing download"
    );
    state.aria2.remove(&gid).await?;
    if let Err(e) = state.aria2.remove_download_result(&gid).await {
        tracing::warn!(gid = %gid, error = %e, "failed to clear download result");
    }
    if !status.is_finished() {
        delete_partial(&state, &status).await;
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(serde::Deserialize)]
pub struct BrowseQuery {
    #[serde(default)]
    pub path: String,
}

pub async fn browse(
    State(state): State<AppState>,
    Query(q): Query<BrowseQuery>,
) -> AppResult<Response> {
    let view = if q.path.is_empty() {
        views::Browse {
            parent: None,
            path: String::new(),
            dirs: state
                .config
                .roots
                .iter()
                .map(|r| DirView {
                    name: r.name.clone(),
                    path: r.path.to_string_lossy().into_owned(),
                })
                .collect(),
        }
    } else {
        // `resolve_existing`, not `resolve`: the directory has to exist to be
        // listed, and canonicalising it is what catches a symlink pointing
        // somewhere lexically-inside-a-root but actually not — `resolve`
        // alone would leak that listing.
        let dir = state
            .config
            .resolve_existing(&q.path)
            .await
            .ok_or_else(|| {
                AppError::BadRequest("path is not inside a configured root".to_string())
            })?;

        // The only filesystem read on any request path: tokio::fs, never
        // std::fs, because blocking IO in an async handler is how a thrashing
        // disk takes down the whole server.
        let mut entries = tokio::fs::read_dir(&dir)
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        let mut dirs = Vec::new();
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| AppError::Internal(e.into()))?
        {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') {
                continue;
            }
            let file_type = entry
                .file_type()
                .await
                .map_err(|e| AppError::Internal(e.into()))?;
            if !file_type.is_dir() {
                continue;
            }
            dirs.push(DirView {
                name: name.into_owned(),
                path: entry.path().to_string_lossy().into_owned(),
            });
        }
        dirs.sort_by(|a, b| a.name.cmp(&b.name));

        // `Some` only when the parent is itself inside a root — an absent
        // link is what tells the picker that browsing upward stops here.
        let parent = match dir.parent() {
            Some(p) => {
                let p = p.to_string_lossy().into_owned();
                state.config.resolve_existing(&p).await.map(|_| p)
            }
            None => None,
        };

        views::Browse {
            parent,
            path: q.path.clone(),
            dirs,
        }
    };

    let html = view.render().map_err(|e| AppError::Internal(e.into()))?;
    let event = patch_elements(&html);
    Ok(Sse::new(stream::once(async move { Ok::<_, Infallible>(event) })).into_response())
}

#[derive(serde::Deserialize)]
pub struct MkdirForm {
    pub parent: String,
    pub name: String,
}

/// Rejects anything empty, a bare `.`/`..`, or containing a path separator —
/// `mkdir` makes one directory, not a path of them.
fn is_valid_dir_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains('/')
}

pub async fn mkdir(
    State(state): State<AppState>,
    Form(form): Form<MkdirForm>,
) -> AppResult<Response> {
    if !is_valid_dir_name(&form.name) {
        return Err(AppError::BadRequest("invalid directory name".to_string()));
    }
    // `resolve_existing`: the parent has to already exist for `join` below to
    // mean anything, and a symlinked parent should be caught here rather than
    // trusted because its name looked right.
    let parent = state
        .config
        .resolve_existing(&form.parent)
        .await
        .ok_or_else(|| {
            AppError::BadRequest("parent is not inside a configured root".to_string())
        })?;
    let target = parent.join(&form.name);
    let target_str = target.to_string_lossy().into_owned();

    tokio::fs::create_dir_all(&target)
        .await
        .map_err(|e| AppError::Internal(e.into()))?;

    // `resolve` only ever answered for names; `target` exists now, so
    // `resolve_existing` can canonicalise it and catch the case where
    // `form.name` named an existing symlink that `create_dir_all` walked
    // straight through instead of creating anything.
    if state.config.resolve_existing(&target_str).await.is_none() {
        return Err(AppError::Internal(anyhow::anyhow!(
            "mkdir target escaped its root: {target_str}"
        )));
    }

    // Land the picker inside the directory just made, the same view `browse`
    // returns for it.
    browse(State(state), Query(BrowseQuery { path: target_str })).await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::aria2::Aria2;
    use crate::auth::session::Sessions;
    use crate::config::{Config, Oidc};

    fn state(aria2_rpc_url: String) -> AppState {
        AppState {
            config: Arc::new(Config {
                bind_addr: String::new(),
                aria2_rpc_url: aria2_rpc_url.clone(),
                roots: vec![],
                public_url: String::new(),
                oidc: Oidc {
                    issuer: String::new(),
                    client_id: String::new(),
                    client_secret: String::new(),
                },
                telegram: None,
            }),
            aria2: Aria2::new(aria2_rpc_url, reqwest::Client::new()),
            sessions: Sessions::new(),
            http: reqwest::Client::new(),
        }
    }

    /// A closed ephemeral port refuses the connection immediately and
    /// deterministically, unlike a hardcoded port number that might belong to
    /// something else on whatever machine runs this — used everywhere below
    /// that wants an aria2 call to fail without a mock server.
    async fn unreachable_url() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        format!("http://{addr}/jsonrpc")
    }

    /// The failure this exists to survive: an aria2 sidecar that is down —
    /// restarting, or simply never started locally. `page` must still answer
    /// with the real page, not a 500, so there is something to look at.
    #[tokio::test]
    async fn page_degrades_to_an_empty_list_and_a_banner_when_aria2_is_unreachable() {
        let html = page(State(state(unreachable_url().await)))
            .await
            .expect("page must not 500 when aria2 is unreachable")
            .0;
        assert!(
            html.contains("unreachable"),
            "no banner in the rendered page: {html}"
        );
        assert!(
            !html.contains("dl-"),
            "a download row rendered despite aria2 being unreachable: {html}"
        );
    }

    /// The bug this whole function exists to fix: the real `addUri` used to
    /// run while the metadata pass was still registered under the same
    /// infohash, and aria2 rejected it every time with "already registered"
    /// — nothing anyone asked to download ever actually downloaded. This
    /// pins the guard that replaced it: if neither call that is supposed to
    /// free the infohash succeeds, `add` must stop rather than issue an
    /// `addUri` already known to fail the same way.
    #[tokio::test]
    async fn free_infohash_errors_when_neither_call_can_reach_aria2() {
        let app_state = state(unreachable_url().await);
        let result = free_infohash(&app_state, "some-gid").await;
        assert!(
            result.is_err(),
            "must not report the infohash free as fine when aria2 could not be reached at all"
        );
    }

    /// aria2 marks the metadata-only pass with this literal prefix for as
    /// long as it exists — the signal `all_downloads` filters on so it never
    /// reaches the list as if it were something the user asked to watch.
    #[test]
    fn metadata_only_rows_are_recognised_by_name_and_real_ones_are_not() {
        let metadata = Download {
            gid: "m1".to_string(),
            status: Status::Complete,
            total_length: 0,
            completed_length: 0,
            download_speed: 0,
            upload_speed: 0,
            connections: 0,
            num_seeders: 0,
            error_message: None,
            dir: String::new(),
            files: Vec::new(),
            bittorrent_name: Some("[METADATA]Some.Show.S01".to_string()),
        };
        assert!(is_metadata_row(&metadata));

        let real = Download {
            bittorrent_name: Some("Some.Show.S01".to_string()),
            ..metadata
        };
        assert!(!is_metadata_row(&real));
    }

    #[test]
    fn patch_elements_data_prefixes_a_single_line() {
        assert_eq!(
            patch_elements_data("<div>hi</div>"),
            "elements <div>hi</div>"
        );
    }

    #[test]
    fn patch_elements_data_prefixes_every_line() {
        assert_eq!(
            patch_elements_data("<div>\n  <span>hi</span>\n</div>"),
            "elements <div>\nelements   <span>hi</span>\nelements </div>"
        );
    }

    #[test]
    fn a_magnet_link_is_accepted() {
        assert!(is_magnet("magnet:?xt=urn:btih:abc123"));
    }

    #[test]
    fn anything_else_is_rejected() {
        assert!(!is_magnet("http://example.com/foo.torrent"));
        assert!(!is_magnet("foo.torrent"));
        assert!(!is_magnet(""));
    }

    #[test]
    fn a_plain_name_is_valid() {
        assert!(is_valid_dir_name("Show Name S02"));
    }

    #[test]
    fn empty_dot_dotdot_and_nested_names_are_invalid() {
        assert!(!is_valid_dir_name(""));
        assert!(!is_valid_dir_name("."));
        assert!(!is_valid_dir_name(".."));
        assert!(!is_valid_dir_name("a/b"));
    }
}
