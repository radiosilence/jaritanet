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
    // Only the *stopped* list is swept for metadata rows. A resolving one is
    // the only evidence an add exists — see the note below.
    downloads.extend(
        state
            .aria2
            .tell_stopped(0, 100)
            .await?
            .into_iter()
            .filter(|d| !is_metadata_row(d)),
    );
    // Every magnet `add` resolves under its own gid before `follow-torrent`
    // spawns the real download from it (see `finish_add_inner`), and aria2
    // keeps that resolving gid in the stopped list forever afterward —
    // nothing here ever removes it, since the real download is applied to the
    // gid `follow-torrent` spawned rather than a second `addUri` that would
    // need this one's gid freed first. aria2 names it `[METADATA]<name>` for
    // as long as it exists, which is how it is told apart.
    //
    // Sweeping it from *every* list was hiding the add itself. Resolving a
    // magnet means finding peers who will serve the torrent file, which takes
    // as long as it takes and sometimes never finishes — and for that whole
    // window the metadata row was the only record that anything had been
    // added, so the list stayed empty behind a toast promising it would "show
    // up shortly". A magnet that never resolves showed nothing, forever.
    //
    // While it is active or waiting it is exactly the row that should be on
    // screen. Once the real download exists the metadata gid moves to the
    // stopped list, where it is still swept, so it is replaced rather than
    // duplicated.
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

/// aria2's own wording when an `addUri` names an infohash it already has
/// registered — not a parse of any structured field, because the RPC error is
/// a plain string and this is the only thing in it worth matching on.
fn is_already_registered(message: &str) -> bool {
    message.contains("is already registered")
}

/// The `btih:` hash out of a magnet's `xt` parameter, for logging only —
/// nothing here acts on it, aria2 already knows the download by its gid. Not
/// a URI parser, in the same spirit as [`is_magnet`]: this only ever needs to
/// find the one parameter a magnet is expected to carry.
fn magnet_infohash(magnet: &str) -> Option<&str> {
    let after = magnet.split_once("btih:")?.1;
    Some(after.split('&').next().unwrap_or(after))
}

/// Validates and starts the metadata pass, then hands the rest to the
/// background — resolving a magnet's metadata can take real time, and the
/// browser does not hold a `POST` open for it (production: `NS_BINDING_ABORTED`
/// around two seconds, followed by a retry that collided with the still-
/// registered infohash from the abandoned first attempt). `addUri` itself is
/// not what was slow: aria2 answers with a gid immediately and resolves the
/// magnet on its own side afterward, so it is safe to run synchronously and
/// is what makes the already-registered case below a real 4xx rather than
/// something only the background task ever sees.
/// The outcome, in a body Datastar will actually read.
///
/// Datastar discards a non-200 response before it ever looks at what came
/// back: its fetch wrapper returns early on `status !== 200`, ahead of the
/// content-type sniffing that turns a JSON body into a signal patch. So a 400
/// carrying a perfectly good explanation is, to the person who pressed the
/// button, indistinguishable from the button doing nothing — which is exactly
/// what it looked like.
///
/// The outcome therefore travels in the body and the status stays 200. What
/// the status code no longer carries, the server log does: a rejected add is
/// still a warning here, so this is a change to what the browser is told, not
/// to what we can see.
fn add_outcome(message: Option<&str>) -> Response {
    let body = match message {
        None => serde_json::json!({ "add": { "status": "ok" } }),
        Some(m) => serde_json::json!({ "add": { "status": "error", "message": m } }),
    };
    (StatusCode::OK, axum::Json(body)).into_response()
}

pub async fn add(
    State(state): State<AppState>,
    CurrentSession(session): CurrentSession,
    Form(form): Form<AddForm>,
) -> Response {
    // Rejected at the boundary rather than handed to aria2 to fail on later.
    // A file upload is a different interface for a case that does not come up
    // on a phone.
    if !is_magnet(&form.magnet) {
        return add_outcome(Some("That is not a magnet link."));
    }
    let Some(dir) = state.config.resolve(&form.dir) else {
        return add_outcome(Some("Choose a destination inside the library."));
    };
    let dir = dir.to_string_lossy().into_owned();

    // No `bt-metadata-only`: that option means "fetch the metadata and stop"
    // — aria2 never spawns the followed download at all, so `followed_by`
    // below would never appear and every add would run out the clock and
    // fail. Measured against the real compose stack: plain `follow-torrent`
    // (`mem`) still splits into the same parent-resolves/child-downloads
    // shape `finish_add_inner` depends on, it just does not pause for
    // anyone's benefit at the metadata boundary — see the pause/changeOption
    // /unpause dance below for what that costs.
    let metadata_gid = match state
        .aria2
        .add_uri(
            &form.magnet,
            serde_json::json!({"dir": dir, "follow-torrent": "mem"}),
        )
        .await
    {
        Ok(gid) => gid,
        // Not a server fault: this infohash is already known to aria2,
        // either genuinely downloading already or a metadata pass a previous
        // attempt left registered — the pod dying mid-`add` being the likely
        // way, now that finishing it runs detached from the request that
        // started it. aria2's error does not say which, and guessing wrong
        // is worse than asking: forcibly clearing it here could silently
        // cancel a real download. The download list is already on the page —
        // that is where "which one is it" gets answered.
        Err(AppError::Upstream(msg)) if is_already_registered(&msg) => {
            return add_outcome(Some("That is already in the list."));
        }
        Err(e) => {
            tracing::error!(error = %e, "add: aria2 refused the magnet");
            return add_outcome(Some("The download service could not be reached."));
        }
    };

    tokio::spawn(finish_add(
        state,
        session.sub,
        form.magnet,
        dir,
        metadata_gid,
    ));

    add_outcome(None)
}

/// Everything about adding a magnet that cannot happen inside the request
/// that asked for it. Detached by `tokio::spawn`, so the only way its outcome
/// reaches anyone is the SSE stream the page already keeps open — a resolving
/// magnet shows as the `Resolving` row it always did — and, on failure, the
/// log: there is no response left to carry it back to.
async fn finish_add(
    state: AppState,
    sub: String,
    magnet: String,
    dir: String,
    metadata_gid: String,
) {
    if let Err(e) = finish_add_inner(&state, &sub, &dir, &metadata_gid).await {
        tracing::error!(
            gid = %metadata_gid,
            infohash = magnet_infohash(&magnet).unwrap_or("unknown"),
            error = %e,
            "add: failed after the request was already accepted"
        );
    }
}

/// How long to wait for a magnet to resolve before giving up. Measured
/// against the real compose stack: a well-seeded torrent resolved in ~24s,
/// so a minute is thin for anything sparser — this is not a request the
/// caller is waiting on anymore (see `add`), so there is no UX cost to
/// affording a slow swarm real time rather than optimising for a fast one.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(600);

/// Selects and starts the real download by following the metadata-resolving
/// gid to the download aria2 spawned from it, rather than issuing a second
/// `addUri` for the same magnet.
///
/// A magnet's own `files` describes the resolving gid itself — one entry,
/// regardless of how many files the torrent actually has, which is why a
/// three-file torrent used to log `magnet_files=1` and select whichever file
/// happened to sit at index 1. `follow-torrent` (`mem`) spawns a second
/// download from the resolved metadata and links the two by gid —
/// `followedBy` on this one, `following` on that one — and it is that second
/// gid's `files` that lists what the torrent actually contains. Reading the
/// selection from anywhere else means the filter never sees most of the
/// torrent and the choice of what to keep is decided by file order.
///
/// Applying the selection through `changeOption` rather than a second
/// `addUri` also means there is no infohash collision to resolve: one
/// download exists for this magnet from start to finish, under one gid.
///
/// `bt-metadata-only` used to stop aria2 right at that boundary, so the
/// selection was in place before a single content byte arrived. Without it
/// (see `add` for why it had to go — it also stops `followedBy` from ever
/// appearing), the child starts downloading everything the instant it
/// exists. That is what the pause/change/unpause sequence below is for.
async fn finish_add_inner(
    state: &AppState,
    sub: &str,
    dir: &str,
    metadata_gid: &str,
) -> AppResult<()> {
    let deadline = tokio::time::Instant::now() + RESOLVE_TIMEOUT;
    let child_gid = loop {
        let status = state.aria2.tell_status(metadata_gid).await?;
        if status.status == Status::Error {
            return Err(AppError::Upstream(
                status
                    .error_message
                    .unwrap_or_else(|| "metadata fetch failed".to_string()),
            ));
        }
        if let Some(gid) = status.followed_by.into_iter().next() {
            break gid;
        }
        if tokio::time::Instant::now() >= deadline {
            // Not the caller's mistake — a sparse swarm, or one that never
            // shows up at all, is an upstream condition and reads as one.
            return Err(AppError::Upstream(format!(
                "the magnet did not resolve within {}s",
                RESOLVE_TIMEOUT.as_secs()
            )));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    };

    // Freshly created and, without `bt-metadata-only`, already fetching
    // aria2's default selection — every file. Pausing closes most of that
    // window before `changeOption` narrows it; best-effort, because a
    // download that will not pause just keeps fetching everything for the
    // few seconds this takes, which `notify::sweep_garbage` already exists
    // to clean up after. Unpausing back out is not best-effort: if the pause
    // took, it must be undone, or the download sits paused forever with
    // nothing left to tell anyone it is stuck.
    let paused = state.aria2.pause(&child_gid).await.is_ok();

    // The child's file list is already known the moment it is queryable —
    // aria2 only creates it once it has parsed a complete torrent out of the
    // resolved metadata, so there is nothing left to wait for here.
    let files = state.aria2.tell_status(&child_gid).await?.files;
    if files.is_empty() {
        return Err(AppError::Upstream(
            "aria2 followed the metadata pass but the download it created has no files".to_string(),
        ));
    }

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
        sub = %sub,
        magnet_files = files.len(),
        wanted = indices.len(),
        skipped,
        skipped_bytes,
        %dir,
        "starting download"
    );

    state
        .aria2
        .change_option(
            &child_gid,
            serde_json::json!({"dir": dir, "select-file": indices.join(",")}),
        )
        .await?;

    if paused {
        state.aria2.unpause(&child_gid).await?;
    }

    Ok(())
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

    #[test]
    fn already_registered_is_recognised_by_aria2s_own_wording() {
        assert!(is_already_registered(
            "InfoHash abcd1234 is already registered."
        ));
        assert!(!is_already_registered("connection refused"));
    }

    #[test]
    fn magnet_infohash_reads_the_btih_parameter_and_stops_at_the_next_one() {
        assert_eq!(
            magnet_infohash("magnet:?xt=urn:btih:ABCD1234&dn=Some.Show"),
            Some("ABCD1234")
        );
        assert_eq!(magnet_infohash("magnet:?dn=no-hash-here"), None);
    }

    /// Everything below builds a fake aria2 on axum (already a dependency —
    /// its `hyper` server handles connection reuse without a hand-rolled
    /// listener) to exercise `add` and the detached `finish_add` together,
    /// the way a real request does.
    mod add_flow {
        use std::sync::{Arc, Mutex};
        use std::time::Duration as StdDuration;

        use axum::Json;
        use axum::extract::State as AxumState;
        use axum::routing::post;

        use crate::auth::session::Session;
        use crate::config::Root;

        use super::*;

        /// What the mock hands back for `aria2.tellStatus` on the metadata
        /// gid — `NeverResolves` pins "the caller never waits for this" (no
        /// `followedBy` ever appears), `ResolvesWithChild` lets the rest of
        /// the flow run to completion against `child_gid`'s own file list.
        #[derive(Clone)]
        enum MetadataOutcome {
            NeverResolves,
            ResolvesWithChild {
                child_gid: String,
                child_files: serde_json::Value,
            },
        }

        #[derive(Clone)]
        struct MockAria2 {
            calls: Arc<Mutex<Vec<String>>>,
            change_option_calls: Arc<Mutex<Vec<serde_json::Value>>>,
            metadata_add_result: Arc<serde_json::Value>,
            metadata_outcome: MetadataOutcome,
            /// Lets a test exercise the case where the child will not pause —
            /// `finish_add_inner` treats that as tolerable and best-effort.
            pause_should_succeed: bool,
        }

        fn download_result(gid: &str, status: &str, files: serde_json::Value) -> serde_json::Value {
            serde_json::json!({"result": {
                "gid": gid,
                "status": status,
                "totalLength": "100",
                "completedLength": "0",
                "downloadSpeed": "0",
                "uploadSpeed": "0",
                "connections": "0",
                "dir": "/mnt/kontent/movies",
                "files": files,
            }})
        }

        async fn rpc(
            AxumState(mock): AxumState<MockAria2>,
            Json(body): Json<serde_json::Value>,
        ) -> Json<serde_json::Value> {
            let method = body["method"].as_str().unwrap_or_default().to_string();
            let calls_so_far = {
                let mut calls = mock.calls.lock().unwrap();
                calls.push(method.clone());
                calls.iter().filter(|m| *m == "aria2.addUri").count()
            };
            let response = match method.as_str() {
                // No `bt-metadata-only` field to key off any more — there is
                // exactly one `addUri` for a magnet's whole life now, so a
                // second one is the duplicate-infohash bug back, not a
                // legitimate second call to tell apart from the first.
                "aria2.addUri" if calls_so_far == 1 => (*mock.metadata_add_result).clone(),
                "aria2.addUri" => {
                    panic!("a second addUri means the duplicate-infohash bug is back")
                }
                "aria2.pause" => {
                    if mock.pause_should_succeed {
                        serde_json::json!({"result": "OK"})
                    } else {
                        serde_json::json!({"error": {"code": 1, "message": "not pausable"}})
                    }
                }
                "aria2.unpause" => serde_json::json!({"result": "OK"}),
                "aria2.tellStatus" => {
                    let gid = body["params"][0].as_str().unwrap_or_default();
                    match (&mock.metadata_outcome, gid) {
                        (MetadataOutcome::NeverResolves, _) => {
                            download_result("metadata-gid", "active", serde_json::json!([]))
                        }
                        (
                            MetadataOutcome::ResolvesWithChild {
                                child_gid,
                                child_files,
                            },
                            g,
                        ) if g == child_gid => {
                            download_result(child_gid, "active", child_files.clone())
                        }
                        (MetadataOutcome::ResolvesWithChild { child_gid, .. }, _) => {
                            let mut result =
                                download_result("metadata-gid", "complete", serde_json::json!([]));
                            result["result"]["followedBy"] = serde_json::json!([child_gid.clone()]);
                            result
                        }
                    }
                }
                "aria2.changeOption" => {
                    mock.change_option_calls.lock().unwrap().push(body.clone());
                    serde_json::json!({"result": "OK"})
                }
                other => panic!("unexpected aria2 method in test: {other}"),
            };
            let mut envelope = serde_json::json!({"jsonrpc": "2.0", "id": "mariastew"});
            envelope
                .as_object_mut()
                .unwrap()
                .extend(response.as_object().unwrap().clone());
            Json(envelope)
        }

        struct Mock {
            url: String,
            calls: Arc<Mutex<Vec<String>>>,
            change_option_calls: Arc<Mutex<Vec<serde_json::Value>>>,
        }

        async fn mock_server(
            metadata_add_result: serde_json::Value,
            metadata_outcome: MetadataOutcome,
        ) -> Mock {
            mock_server_with_pause(metadata_add_result, metadata_outcome, true).await
        }

        async fn mock_server_with_pause(
            metadata_add_result: serde_json::Value,
            metadata_outcome: MetadataOutcome,
            pause_should_succeed: bool,
        ) -> Mock {
            let calls = Arc::new(Mutex::new(Vec::new()));
            let change_option_calls = Arc::new(Mutex::new(Vec::new()));
            let mock = MockAria2 {
                calls: calls.clone(),
                change_option_calls: change_option_calls.clone(),
                metadata_add_result: Arc::new(metadata_add_result),
                metadata_outcome,
                pause_should_succeed,
            };
            let app = axum::Router::new().route("/", post(rpc)).with_state(mock);
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            Mock {
                url: format!("http://{addr}/"),
                calls,
                change_option_calls,
            }
        }

        fn test_state(aria2_url: String) -> AppState {
            let mut s = state(aria2_url.clone());
            s.config = Arc::new(Config {
                bind_addr: String::new(),
                aria2_rpc_url: aria2_url,
                roots: vec![Root {
                    name: "movies".to_string(),
                    path: std::path::PathBuf::from("/mnt/kontent/movies"),
                }],
                public_url: String::new(),
                oidc: Oidc {
                    issuer: String::new(),
                    client_id: String::new(),
                    client_secret: String::new(),
                },
                telegram: None,
            });
            s
        }

        fn add_form() -> AddForm {
            AddForm {
                magnet: "magnet:?xt=urn:btih:abc".to_string(),
                dir: "/mnt/kontent/movies".to_string(),
            }
        }

        fn session() -> Session {
            Session {
                id: "s".to_string(),
                sub: "tester".to_string(),
                expires: std::time::Instant::now() + StdDuration::from_secs(60),
            }
        }

        async fn wait_for_calls(calls: &Mutex<Vec<String>>, expected: usize) {
            for _ in 0..200 {
                if calls.lock().unwrap().len() >= expected {
                    return;
                }
                tokio::time::sleep(StdDuration::from_millis(10)).await;
            }
            panic!(
                "timed out waiting for {expected} calls, saw {:?}",
                calls.lock().unwrap()
            );
        }

        /// The bug this whole task exists to fix: `add` used to hold the
        /// connection open for as long as the metadata poll took — up to 60s
        /// — which the browser does not wait for. Here the metadata never
        /// resolves at all, and `add` still has to return well inside a
        /// fraction of a second, because the only thing standing between the
        /// caller and a response is one `addUri` round trip.
        #[tokio::test]
        async fn add_returns_before_the_metadata_poll_completes() {
            let mock = mock_server(
                serde_json::json!({"result": "metadata-gid"}),
                MetadataOutcome::NeverResolves,
            )
            .await;
            let state = test_state(mock.url);

            let response = tokio::time::timeout(
                StdDuration::from_millis(500),
                add(State(state), CurrentSession(session()), Form(add_form())),
            )
            .await
            .expect("add must return promptly, not wait on the metadata poll");

            // 200, not 202: Datastar discards a non-200 before reading the
            // body, so an accepted add has to say so in a response it will
            // actually look at. See `add_outcome`.
            assert_eq!(response.status(), StatusCode::OK);
        }

        /// The bug this whole task exists to fix: the file list used to be
        /// read from the metadata gid's own `files` (always one entry,
        /// itself), not the download `follow-torrent` spawned from it. A
        /// three-file torrent where the video is *not* index 1 is exactly
        /// the case that got the selection wrong: `magnet_files=1` regardless
        /// of the torrent's real shape, and whichever file happened to sit at
        /// index 1 was what got selected — the video only by luck.
        #[tokio::test]
        async fn finish_add_reads_the_selection_from_the_followed_downloads_file_list() {
            // The shape of the second live failure: a multi-file release
            // with the video at index 2 (not 1) and a nested `Other/`
            // subdirectory — a torrent's `files` list has no directory
            // entries of its own, only full paths, so `Other/...` shows up
            // exactly like any other nested path. Index 1 and the `Other/`
            // entry are unambiguous `filter::is_garbage` matches (`.nfo`,
            // `.jpg`); a selection computed from the wrong file list (the
            // metadata gid's own, always length 1) could only ever have
            // picked the right one by coincidence.
            let child_files = serde_json::json!([
                {"index": "1", "path": "/mnt/kontent/movies/Pulp Fiction (1994) [1080p]/RARBG.nfo", "length": "473", "selected": "true"},
                {"index": "2", "path": "/mnt/kontent/movies/Pulp Fiction (1994) [1080p]/Pulp.Fiction.1994.1080p.BrRip.x264.YIFY.mp4", "length": "1932735283", "selected": "true"},
                {"index": "3", "path": "/mnt/kontent/movies/Pulp Fiction (1994) [1080p]/Other/YTS.MX.jpg", "length": "53226", "selected": "true"},
            ]);
            let mock = mock_server(
                serde_json::json!({"result": "metadata-gid"}),
                MetadataOutcome::ResolvesWithChild {
                    child_gid: "child-gid".to_string(),
                    child_files,
                },
            )
            .await;
            let state = test_state(mock.url);

            add(State(state), CurrentSession(session()), Form(add_form())).await;

            wait_for_calls(&mock.calls, 6).await;
            assert_eq!(
                mock.calls.lock().unwrap().as_slice(),
                [
                    "aria2.addUri",
                    "aria2.tellStatus",
                    "aria2.pause",
                    "aria2.tellStatus",
                    "aria2.changeOption",
                    "aria2.unpause",
                ]
            );

            let change_option_calls = mock.change_option_calls.lock().unwrap();
            assert_eq!(change_option_calls.len(), 1);
            let params = &change_option_calls[0]["params"];
            assert_eq!(params[0], "child-gid");
            assert_eq!(params[1]["select-file"], "2");
            assert_eq!(params[1]["dir"], "/mnt/kontent/movies");
        }

        /// The pause is best-effort — a child that will not pause must not
        /// stop the add, since `notify::sweep_garbage` is the backstop for
        /// whatever it fetches in the meantime. What must not happen is an
        /// `unpause` call for a pause that never took: that would either
        /// error against a gid aria2 never actually paused, or (worse, if
        /// aria2 tolerated it) mask a real pause/unpause mismatch elsewhere.
        #[tokio::test]
        async fn finish_add_tolerates_a_child_that_will_not_pause() {
            let child_files = serde_json::json!([
                {"index": "1", "path": "/mnt/kontent/movies/movie.mkv", "length": "100", "selected": "true"},
            ]);
            let mock = mock_server_with_pause(
                serde_json::json!({"result": "metadata-gid"}),
                MetadataOutcome::ResolvesWithChild {
                    child_gid: "child-gid".to_string(),
                    child_files,
                },
                false,
            )
            .await;
            let state = test_state(mock.url);

            add(State(state), CurrentSession(session()), Form(add_form())).await;

            wait_for_calls(&mock.calls, 5).await;
            assert_eq!(
                mock.calls.lock().unwrap().as_slice(),
                [
                    "aria2.addUri",
                    "aria2.tellStatus",
                    "aria2.pause",
                    "aria2.tellStatus",
                    "aria2.changeOption",
                ],
                "a failed pause must not be followed by an unpause"
            );
        }

        /// This magnet already being known to aria2 is not a server fault —
        /// it must read as a 4xx the caller can act on, not the 502 an
        /// unrecognised upstream error gets.
        #[tokio::test]
        async fn add_reports_an_already_registered_infohash_in_a_body_the_client_reads() {
            let mock = mock_server(
                serde_json::json!({"error": {"code": 1, "message": "InfoHash abc is already registered."}}),
                MetadataOutcome::NeverResolves,
            )
            .await;
            let state = test_state(mock.url);

            let response = add(State(state), CurrentSession(session()), Form(add_form())).await;

            // The status has to stay 200 for the explanation to survive the
            // trip: Datastar returns early on anything else and never reads
            // the body, so a 4xx here would reach the person as silence.
            assert_eq!(response.status(), StatusCode::OK);
            let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
                .await
                .expect("a small json body");
            let body: serde_json::Value =
                serde_json::from_slice(&body).expect("add answers with json");
            assert_eq!(body["add"]["status"], "error");
            assert!(
                body["add"]["message"]
                    .as_str()
                    .is_some_and(|m| !m.is_empty()),
                "the rejection has to say something, got {body}"
            );
        }
    }

    /// The row a resolving magnet is shown as, once the marker is stripped.
    /// Nothing about "starting" should read as an implementation detail.
    #[test]
    fn a_resolving_magnet_is_named_without_the_marker_and_reads_as_starting() {
        let metadata = Download {
            gid: "m1".to_string(),
            status: Status::Active,
            total_length: 0,
            completed_length: 0,
            download_speed: 0,
            upload_speed: 0,
            connections: 0,
            num_seeders: 0,
            error_message: None,
            dir: String::new(),
            files: Vec::new(),
            bittorrent_name: Some("[METADATA]abc123".to_string()),
            followed_by: Vec::new(),
        };
        let row = crate::views::Row::from(&metadata);
        assert_eq!(row.name, "abc123", "the marker should not be on screen");
        assert_eq!(row.state, "starting");
        assert!(
            row.percent.is_none(),
            "nothing is known about size yet, so the bar is indeterminate"
        );
    }

    /// aria2 marks the metadata-only pass with this literal prefix for as
    /// long as it exists. It is swept from the stopped list, where it lingers
    /// forever after the real download has taken over — but *not* from the
    /// active one, where it is the only evidence an add happened at all.
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
            followed_by: Vec::new(),
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
