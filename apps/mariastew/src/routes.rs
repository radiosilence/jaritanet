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
use crate::poll::RenderedRow;
use crate::state::AppState;
use crate::views::{self, DirView, RootView, Row};

/// How often a stream re-checks that its session still exists. Deliberately
/// not the poll rate: this is a revocation check on a page that may be open for
/// hours, and it takes the write lock on the session map every time it runs —
/// a cost worth paying once a second and not ten times.
const SESSION_RECHECK: Duration = Duration::from_secs(1);

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
/// errored — the order `page` renders them in, and the order every snapshot
/// the poller publishes carries.
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
            .filter(|d| !d.is_metadata()),
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
    // window the metadata row is the only record that anything has been added.
    // A magnet that never resolves showed nothing, forever. It is also what the
    // UI confirms an add with, now that nothing else does.
    //
    // While it is active or waiting it is exactly the row that should be on
    // screen. Once the real download exists the metadata gid moves to the
    // stopped list, where it is still swept, so it is replaced rather than
    // duplicated.
    Ok(downloads)
}

/// Every download rendered, each carrying its own history. The log is read
/// per row rather than once for the list because it is keyed by gid and a
/// download that has none — anything already in aria2 before this pod
/// started — simply renders without the panel.
pub(crate) fn rows(state: &AppState, downloads: &[Download]) -> Vec<Row> {
    downloads
        .iter()
        .map(|d| {
            Row::new(
                d,
                state.activity.entries(&d.gid),
                state.clearing.contains(&d.gid),
            )
        })
        .collect()
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
/// element id, so a row arrives at whatever element already carries its gid
/// and there is no client-side state to keep in step with it. Which rows are
/// worth sending is decided server-side, in [`unsent`].
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
        Ok(downloads) => (rows(&state, &downloads), false),
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

/// Which of a snapshot's rows a connection has not already sent, recording
/// what it is about to. `None` means the downloads themselves moved — one
/// arrived, one left, or one changed place in the order — which is the case a
/// morph by id cannot express and the caller answers with the whole container.
///
/// `sent` is what went down *this* connection rather than what the previous
/// snapshot held, which is the whole reason this takes it as an argument: a
/// client too slow to collect every tick skips some, and a row that changed in
/// one it never saw still has to reach it.
///
/// `None` for `sent` is a connection that has sent nothing yet, and it always
/// asks for the container. That was already what happened for every list with
/// a row in it, since no row had been sent; an empty one took the other branch
/// and sent nothing at all, which left a page rendered while aria2 was down
/// showing its warning until someone reloaded. The container `#downloads` now
/// carries that warning, so replacing it once per connection is what retires
/// it — and a stream's first tick agreeing with the server costs one message.
fn unsent<'a>(
    sent: &mut Option<Vec<(String, u64)>>,
    rows: &'a [RenderedRow],
) -> Option<Vec<&'a RenderedRow>> {
    let changed = sent.as_ref().and_then(|sent| {
        let same_downloads = sent.len() == rows.len()
            && sent.iter().zip(rows).all(|((gid, _), row)| *gid == row.gid);
        same_downloads.then(|| {
            sent.iter()
                .zip(rows)
                .filter(|((_, hash), row)| *hash != row.hash)
                .map(|(_, row)| row)
                .collect()
        })
    });
    *sent = Some(rows.iter().map(|r| (r.gid.clone(), r.hash)).collect());
    changed
}

/// One long-lived stream per page, fed by the process-wide poller rather than
/// by a poll of its own — which is what lets the rate be a rate anyone would
/// call smooth, since a second tab no longer doubles what aria2 is asked.
///
/// It sends rows, not the list. Every snapshot arrives with each row already
/// rendered and hashed, and this compares those hashes against what it last
/// sent *down this connection* rather than against the previous snapshot: a
/// client too slow to collect every tick skips some, and a row that changed in
/// one it missed still has to reach it.
///
/// The exception is a download appearing or disappearing. Datastar morphs by
/// id, which can neither add an element nor remove one, so a change in
/// membership is the one case that sends the whole container.
pub async fn stream(
    State(state): State<AppState>,
    CurrentSession(session): CurrentSession,
) -> Response {
    let session_id = session.id;
    // Held inside the stream: dropping it is what tells the poller this page
    // is gone, and it goes when the response does.
    let mut viewer = state.poll.viewer();
    let s = async_stream::stream! {
        let mut sent: Option<Vec<(String, u64)>> = None;
        let mut checked = std::time::Instant::now() - SESSION_RECHECK;

        while let Some(snapshot) = viewer.next().await {
            // A page left open holds this connection for hours; a session
            // revoked in the meantime is never re-checked by anything else,
            // so logging out would otherwise leave a live feed of the queue
            // attached to a browser no longer permitted to see it.
            if checked.elapsed() >= SESSION_RECHECK {
                checked = std::time::Instant::now();
                if state.sessions.get(&session_id).await.is_none() {
                    break;
                }
            }

            let Some(view) = &snapshot.view else {
                continue;
            };

            match unsent(&mut sent, &view.rows) {
                Some(rows) => for row in rows {
                    yield Ok::<_, Infallible>(patch_elements(&row.html));
                },
                None => yield Ok::<_, Infallible>(patch_elements(&view.full)),
            }
        }
    };

    Sse::new(s).keep_alive(KeepAlive::default()).into_response()
}

#[derive(serde::Deserialize)]
pub struct AddForm {
    pub magnet: String,
    pub dir: String,
}

fn is_magnet(s: &str) -> bool {
    s.starts_with("magnet:?")
}

fn is_already_registered(message: &str) -> bool {
    message.contains("is already registered")
}

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
    // Flat signal names, not one nested `add` object — see the note on
    // `data-signals__ifmissing` in page.html for why the client cannot read a
    // nested one reliably.
    let body = match message {
        None => serde_json::json!({ "addStatus": "ok" }),
        Some(m) => serde_json::json!({ "addStatus": "error", "addMessage": m }),
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

    state
        .activity
        .record(&metadata_gid, format!("added — destination {dir}"));
    state
        .activity
        .record(&metadata_gid, "looking for peers who have the torrent file");

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
        // The response is long gone, so this log was the only record — and
        // nobody reads a pod's log to find out why a row on their phone has
        // said "finding peers" for ten minutes. The row itself says now.
        state
            .activity
            .record(&metadata_gid, format!("failed — {e}"));
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
/// `--pause-metadata` is what makes the narrowing safe, and it is set on the
/// aria2 process rather than here. aria2 creates the followed download already
/// paused, so the selection is in place before a single content byte arrives
/// and this only has to release it at the end.
///
/// Two earlier shapes are worth remembering, because both are worse. Asking
/// for `bt-metadata-only` stops aria2 *before* it spawns the followed download
/// at all, so `followedBy` never appears and every add runs out the clock —
/// see `add`. Pausing the child from here instead lost a race with itself:
/// aria2 refuses to unpause a group until it has finished stopping, the child
/// fetched every file in the torrent in the meantime, and a process that died
/// in that window left a download aria2 serialised as paused with nothing that
/// would ever start it.
///
/// So the pause is not made here and its absence is not assumed either — the
/// child's own status decides whether there is anything to release, which is
/// also what keeps this working against an aria2 started without the option.
pub(crate) async fn finish_add_inner(
    state: &AppState,
    sub: &str,
    dir: &str,
    metadata_gid: &str,
) -> AppResult<()> {
    // Held for the whole sequence, so the reconciler in `resume` — which
    // recognises an unfinished add by exactly the state this is standing in
    // the middle of — leaves this one alone. Dropped on every exit, `?`
    // included.
    let _adding = state.adding.claim(metadata_gid);

    let child_gid = follow(state, metadata_gid).await?;

    // An adopted add is already the download it would have been followed to
    // (see `follow`), so there is no second gid to link a history to and no
    // second claim to take — both were done under this one.
    let followed = child_gid != metadata_gid;

    // The history so far was written under the gid that resolved the magnet,
    // and that gid is about to leave every list this UI reads. From here both
    // names reach one log.
    let _adding_child = followed.then(|| {
        // Claimed before the first await that could let the reconciler see it:
        // a child born paused with no selection is exactly what `resume`
        // adopts, and this is the task already doing that.
        state.activity.link(metadata_gid, &child_gid);
        state.adding.claim(&child_gid)
    });
    state
        .activity
        .record(&child_gid, "torrent file arrived — choosing files");

    // The child's file list is already known the moment it is queryable —
    // aria2 only creates it once it has parsed a complete torrent out of the
    // resolved metadata, so a paused child still answers with every file in
    // it, which is the whole reason the selection can be applied before
    // anything is fetched.
    let child = state.aria2.tell_status(&child_gid).await?;
    let paused = child.status == Status::Paused;
    let files = child.files;
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
    state.activity.record(
        &child_gid,
        format!(
            "keeping {} of {} files, skipping {skipped} ({})",
            indices.len(),
            files.len(),
            views::bytes(skipped_bytes)
        ),
    );

    state
        .aria2
        .change_option(
            &child_gid,
            serde_json::json!({"dir": dir, "select-file": indices.join(",")}),
        )
        .await?;

    if paused {
        unpause_settled(state, &child_gid).await?;
    }
    state.activity.record(&child_gid, "downloading");

    Ok(())
}

/// The download a selection has to be applied to, given the gid an add is
/// known by.
///
/// Normally that is not the same gid: a magnet resolves under its own, and
/// `follow-torrent` spawns the real download beside it. But `resume` adopts an
/// add by whatever aria2 is holding, and after a restart that is often the
/// spawned download itself — `--bt-load-saved-metadata` reads the torrent off
/// the disk during start-up, so there is no metadata pass left to wait for and
/// no `followedBy` that will ever appear. Waiting for one anyway is ten
/// minutes of polling followed by a timeout, with the download running
/// unnarrowed the whole time. That is what this exists to tell apart.
///
/// The two are distinguishable and not by their gids: aria2 gives an
/// unresolved magnet no `bittorrent.info.name` and a single file called
/// `[METADATA]<dn>`, which is what `is_metadata` reads, while a real download
/// carries the torrent's own name and its real file list.
async fn follow(state: &AppState, gid: &str) -> AppResult<String> {
    let deadline = tokio::time::Instant::now() + RESOLVE_TIMEOUT;
    loop {
        let status = state.aria2.tell_status(gid).await?;
        if status.status == Status::Error {
            return Err(AppError::Upstream(
                status
                    .error_message
                    .unwrap_or_else(|| "metadata fetch failed".to_string()),
            ));
        }
        if let Some(child) = status.followed_by.first() {
            return Ok(child.clone());
        }
        if !status.is_metadata() && !status.files.is_empty() {
            return Ok(gid.to_string());
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
    }
}

/// How long to keep offering aria2 the chance to accept the unpause above.
/// Generous, because the only thing waiting on it is a download that is
/// already stopped, and giving up early is the failure this bounds.
const UNPAUSE_TIMEOUT: Duration = Duration::from_secs(15);

/// Undoes the pause above, allowing for aria2 not being ready to yet.
///
/// A pause is a request rather than an act: the group keeps running until it
/// has closed what it had open, and until it reaches the reserved queue aria2
/// answers `GID#… cannot be unpaused now`. The pause a few lines up is what
/// puts it in that window, so the two race on every add — reproducibly, on a
/// real swarm — and losing costs the entire download: a paused group with no
/// task left to start it sits there with nothing to say why.
async fn unpause_settled(state: &AppState, gid: &str) -> AppResult<()> {
    let deadline = tokio::time::Instant::now() + UNPAUSE_TIMEOUT;
    loop {
        match state.aria2.unpause(gid).await {
            Ok(()) => return Ok(()),
            Err(e) if tokio::time::Instant::now() >= deadline => return Err(e),
            Err(e) => {
                tracing::debug!(%gid, error = %e, "add: aria2 will not unpause yet, retrying");
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
    }
}

pub async fn pause(State(state): State<AppState>, Path(gid): Path<String>) -> AppResult<Response> {
    state.aria2.pause(&gid).await?;
    state.activity.record(&gid, "paused");
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn resume(State(state): State<AppState>, Path(gid): Path<String>) -> AppResult<Response> {
    state.aria2.unpause(&gid).await?;
    state.activity.record(&gid, "resumed");
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

/// How long to keep asking aria2 whether it has actually let go, and how often.
/// `forceRemove` stops the download outright, but it arrives in the stopped
/// list a moment after the call returns and `removeDownloadResult` refuses it
/// until it does — so one attempt is not enough and a second usually is. The
/// request is held open for this, which is what keeps the budget to a second:
/// giving up hands the row its controls back and answers with a status, which
/// is the honest outcome — the download really is still there.
const CLEAR_ATTEMPTS: u32 = 10;
const CLEAR_POLL: Duration = Duration::from_millis(100);

/// Make aria2 forget a download, then delete whatever it should not have left
/// behind.
///
/// The two removal calls apply to different downloads and each refuses the
/// other's: `remove` stops one that is still running, `removeDownloadResult`
/// discards one that has already stopped. Every errored row is the second kind
/// and so is a torrent aria2 is no longer seeding, so the single `remove` this
/// used to start with failed outright and the handler gave up before reaching
/// the call that would have worked — the row stayed, and every later press
/// failed the same way, which is what "the button does nothing" was.
///
/// aria2 is also not finished the instant `remove` returns: the download moves
/// to the stopped list first, and `removeDownloadResult` refuses it until it
/// arrives. So what decides the outcome here is not whether a call succeeded
/// but whether the gid is still in a list the page reads — the same question
/// the row on screen is asking, and the answer this returns.
async fn clear(state: &AppState, gid: &str, status: &Download) -> bool {
    if !status.is_stopped()
        && let Err(e) = state.aria2.remove(gid).await
    {
        tracing::warn!(gid = %gid, error = %e, "could not stop download, discarding it anyway");
    }

    let mut gone = false;
    for attempt in 0..CLEAR_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(CLEAR_POLL).await;
        }
        let _ = state.aria2.remove_download_result(gid).await;
        match all_downloads(state).await {
            Ok(downloads) => gone = !downloads.iter().any(|d| d.gid == gid),
            Err(e) => tracing::warn!(gid = %gid, error = %e, "clear: aria2 poll failed"),
        }
        if gone {
            break;
        }
    }

    if gone {
        if !status.is_finished() {
            delete_partial(state, status).await;
        }
        // Nothing will render this row again, so its history has nothing left
        // to explain — this is the one place a log goes away before the cap
        // takes it.
        state.activity.forget(gid);
    } else {
        tracing::warn!(gid = %gid, "aria2 still lists the download after removal");
        state.activity.record(gid, "aria2 would not let go of it");
    }
    state.clearing.end(gid);
    gone
}

/// Two behaviours behind one button, decided by whether the download completed.
/// In progress, the partial data goes with it — a half-downloaded episode
/// sitting in the library is the mess this exists to avoid. Finished and
/// seeding, the files stay: that is stopping an upload, not undoing a download,
/// and deleting the episode would be astonishing.
///
/// The response is held until aria2 has actually let go, so the button's own
/// loading state is the wait rather than a guess at it, and a removal that does
/// not take answers with a status instead of a silent 204 over a row that is
/// still there. That is affordable now only because the stop is `forceRemove`:
/// the graceful one waited on the swarm, which is the open-ended wait
/// `finish_add` is detached for.
///
/// `clear` runs in a task that is then awaited rather than inline. A browser
/// that gives up on the response drops this future, and the removal has to
/// outlive that — aria2 has already been told to stop by then, and abandoning
/// the rest would leave the gid marked `clearing` with nothing left to lift it.
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
    // A second press while the first removal is still in flight waits on
    // nothing: the row it would report on is already rendering as `clearing`
    // from the request that owns it.
    if !state.clearing.begin(&gid) {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    state.activity.record(&gid, "clearing");
    let task = tokio::spawn({
        let state = state.clone();
        let gid = gid.clone();
        async move { clear(&state, &gid, &status).await }
    });
    match task.await {
        Ok(true) => Ok(StatusCode::NO_CONTENT.into_response()),
        Ok(false) => Err(AppError::Upstream(format!(
            "aria2 still lists {gid} after being told to drop it"
        ))),
        // Only a panic reaches here, and `clear` lifts the mark on every path
        // it returns from — so this is the one place left that can strand a row
        // as permanently clearing.
        Err(e) => {
            state.clearing.end(&gid);
            Err(AppError::Internal(anyhow::anyhow!(
                "clearing {gid} panicked: {e}"
            )))
        }
    }
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
            label: String::new(),
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

        // Labelled from `dir` rather than from `q.path`: the two differ only
        // when the request came in through a symlink, and the canonical one is
        // the place the download actually lands.
        views::Browse {
            parent,
            label: state.config.label(&dir),
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

/// How long the filesystem gets — see the call site in `mkdir`.
const FS_TIMEOUT: Duration = Duration::from_secs(10);

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

    // The one mutation here that is not an aria2 call, and so not covered by
    // that client's own ceiling. A `mkdir` against the library's spinning disks
    // takes a moment; taking this long is a mount that has gone away, and the
    // request is held open for it — an uninterruptible `create_dir_all` on a
    // dead NFS handle would otherwise be a spinner with no end.
    tokio::time::timeout(FS_TIMEOUT, tokio::fs::create_dir_all(&target))
        .await
        .map_err(|_| AppError::Internal(anyhow::anyhow!("mkdir timed out: {target_str}")))?
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
    use crate::config::Config;

    fn state(aria2_rpc_url: String) -> AppState {
        AppState {
            config: Arc::new(Config {
                aria2_rpc_url: aria2_rpc_url.clone(),
                ..Config::fixture()
            }),
            aria2: Aria2::new(aria2_rpc_url, reqwest::Client::new()),
            sessions: Sessions::new(),
            activity: crate::activity::Activity::new(),
            poll: crate::poll::Poll::new(),
            clearing: crate::state::Clearing::default(),
            adding: Default::default(),
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

    fn rendered(rows: &[(&str, u64)]) -> Vec<RenderedRow> {
        rows.iter()
            .map(|(gid, hash)| RenderedRow {
                gid: gid.to_string(),
                hash: *hash,
                html: format!("<details id=\"dl-{gid}\">{hash}</details>").into(),
            })
            .collect()
    }

    fn gids(rows: &[&RenderedRow]) -> Vec<String> {
        rows.iter().map(|r| r.gid.clone()).collect()
    }

    /// The saving. A seeding torrent's markup is the same markup every tick,
    /// and at ten ticks a second re-sending it is the whole bill.
    #[test]
    fn a_row_that_did_not_change_is_not_sent_again() {
        let mut sent = None;
        let rows = rendered(&[("a", 1), ("b", 2)]);

        assert!(unsent(&mut sent, &rows).is_none(), "the first tick has no");
        assert!(unsent(&mut sent, &rows).unwrap().is_empty());

        let rows = rendered(&[("a", 1), ("b", 9)]);
        assert_eq!(gids(&unsent(&mut sent, &rows).unwrap()), ["b"]);
        assert!(unsent(&mut sent, &rows).unwrap().is_empty());
    }

    /// A client too slow to collect every tick skips some, and `watch` keeps
    /// only the latest — so a row that changed in a tick nobody read still has
    /// to arrive. This is why the comparison is against what went down this
    /// connection rather than against the previous snapshot.
    #[test]
    fn a_change_made_during_a_skipped_tick_still_reaches_the_client() {
        let mut sent = None;
        unsent(&mut sent, &rendered(&[("a", 1), ("b", 2)]));

        // Tick two changed `a`, and this client never saw it. Tick three
        // changed `b` as well.
        let three = rendered(&[("a", 5), ("b", 6)]);
        assert_eq!(gids(&unsent(&mut sent, &three).unwrap()), ["a", "b"]);
    }

    /// Morphing by id can neither add an element nor remove one, so a download
    /// arriving or leaving is the one change a row patch cannot express.
    #[test]
    fn a_download_arriving_or_leaving_asks_for_the_whole_container() {
        let mut sent = None;
        unsent(&mut sent, &rendered(&[("a", 1), ("b", 2)]));

        assert!(unsent(&mut sent, &rendered(&[("a", 1), ("b", 2), ("c", 3)])).is_none());
        assert!(unsent(&mut sent, &rendered(&[("a", 1), ("c", 3)])).is_none());
    }

    /// A page rendered while aria2 was down carries a warning inside
    /// `#downloads`, and nothing else ever replaces that container while the
    /// queue stays empty. So the first tick has to, even with no rows to send
    /// — otherwise the warning outlives the outage until someone reloads.
    #[test]
    fn an_empty_first_tick_still_asks_for_the_container() {
        let mut sent = None;
        assert!(unsent(&mut sent, &[]).is_none());
        // And only the first: an empty queue that stays empty is silent.
        assert!(unsent(&mut sent, &[]).unwrap().is_empty());
    }

    /// Same downloads, different order — an active one stopping moves it down
    /// the list (see `all_downloads`). A morph by id leaves them where they
    /// were, so this needs the container too.
    #[test]
    fn a_reordering_asks_for_the_whole_container() {
        let mut sent = None;
        unsent(&mut sent, &rendered(&[("a", 1), ("b", 2)]));
        assert!(unsent(&mut sent, &rendered(&[("b", 2), ("a", 1)])).is_none());
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
            /// How aria2 hands the followed download over. `--pause-metadata`
            /// makes that "paused" in production; "active" is an aria2 started
            /// without it, which must not then be unpaused.
            child_status: &'static str,
            /// How many `unpause` calls are refused before one is accepted,
            /// standing in for the window a real pause takes to settle. See
            /// [`unpause_settled`].
            unpause_refusals: Arc<Mutex<u32>>,
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
                // The add pauses nothing any more: `--pause-metadata` hands
                // the child over already stopped, which is what closed both
                // the race with our own pause and the window where aria2 was
                // fetching every file in the torrent.
                "aria2.pause" => panic!("finish_add must not pause anything itself"),
                "aria2.unpause" => {
                    let mut refusals = mock.unpause_refusals.lock().unwrap();
                    if *refusals > 0 {
                        *refusals -= 1;
                        serde_json::json!({"error": {
                            "code": 1,
                            "message": "GID#child-gid cannot be unpaused now",
                        }})
                    } else {
                        serde_json::json!({"result": "OK"})
                    }
                }
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
                            download_result(child_gid, mock.child_status, child_files.clone())
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
            mock_server_with(metadata_add_result, metadata_outcome, "paused", 0).await
        }

        /// `child_status` is how aria2 hands the followed download over, and
        /// `unpause_refusals` is it declining to take it back — the two ends
        /// of the only thing `finish_add_inner` still does to a pause.
        async fn mock_server_with(
            metadata_add_result: serde_json::Value,
            metadata_outcome: MetadataOutcome,
            child_status: &'static str,
            unpause_refusals: u32,
        ) -> Mock {
            let calls = Arc::new(Mutex::new(Vec::new()));
            let change_option_calls = Arc::new(Mutex::new(Vec::new()));
            let mock = MockAria2 {
                calls: calls.clone(),
                change_option_calls: change_option_calls.clone(),
                metadata_add_result: Arc::new(metadata_add_result),
                metadata_outcome,
                child_status,
                unpause_refusals: Arc::new(Mutex::new(unpause_refusals)),
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
                aria2_rpc_url: aria2_url,
                roots: vec![Root {
                    name: "movies".to_string(),
                    path: std::path::PathBuf::from("/mnt/kontent/movies"),
                }],
                ..Config::fixture()
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
                {"index": "1", "path": "/mnt/kontent/movies/Nightfall Harbour (1994) [1080p]/PACKGRP.nfo", "length": "473", "selected": "true"},
                {"index": "2", "path": "/mnt/kontent/movies/Nightfall Harbour (1994) [1080p]/Nightfall.Harbour.1994.1080p.BrRip.x264.QUARRY.mp4", "length": "1932735283", "selected": "true"},
                {"index": "3", "path": "/mnt/kontent/movies/Nightfall Harbour (1994) [1080p]/Other/COVERART.jpg", "length": "53226", "selected": "true"},
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

            wait_for_calls(&mock.calls, 5).await;
            assert_eq!(
                mock.calls.lock().unwrap().as_slice(),
                [
                    "aria2.addUri",
                    "aria2.tellStatus",
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

        /// The account of an add is written under the gid that resolves the
        /// magnet, and that gid leaves every list this UI reads the moment
        /// the real download exists. Without the link in `finish_add_inner`
        /// the only row left on screen would have no history at all — which
        /// is the half of #298 that a per-torrent log panel exists for.
        #[tokio::test]
        async fn the_history_of_an_add_follows_the_download_it_produced() {
            let child_files = serde_json::json!([
                {"index": "1", "path": "/mnt/kontent/movies/movie.mkv", "length": "100", "selected": "true"},
                {"index": "2", "path": "/mnt/kontent/movies/PACKGRP.nfo", "length": "473", "selected": "true"},
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
            let activity = state.activity.clone();

            add(State(state), CurrentSession(session()), Form(add_form())).await;
            wait_for_calls(&mock.calls, 5).await;

            let messages: Vec<String> = activity
                .entries("child-gid")
                .into_iter()
                .map(|e| e.message)
                .collect();
            assert!(
                messages
                    .iter()
                    .any(|m| m.contains("added — destination /mnt/kontent/movies")),
                "the child lost what was recorded before it existed: {messages:?}"
            );
            assert!(
                messages
                    .iter()
                    .any(|m| m.contains("keeping 1 of 2 files, skipping 1")),
                "the filter's decision is not in the log: {messages:?}"
            );
        }

        /// `--pause-metadata` lives on the aria2 process, so the add cannot
        /// assume it: an aria2 started without it hands the child over already
        /// running. Unpausing that is not harmless — aria2 answers
        /// `cannot be unpaused now` for a group it never paused — so the
        /// child's own status is what decides, not what this hoped for.
        #[tokio::test]
        async fn a_child_aria2_handed_over_running_is_not_unpaused() {
            let child_files = serde_json::json!([
                {"index": "1", "path": "/mnt/kontent/movies/movie.mkv", "length": "100", "selected": "true"},
            ]);
            let mock = mock_server_with(
                serde_json::json!({"result": "metadata-gid"}),
                MetadataOutcome::ResolvesWithChild {
                    child_gid: "child-gid".to_string(),
                    child_files,
                },
                "active",
                0,
            )
            .await;
            let state = test_state(mock.url);

            add(State(state), CurrentSession(session()), Form(add_form())).await;

            wait_for_calls(&mock.calls, 4).await;
            assert_eq!(
                mock.calls.lock().unwrap().as_slice(),
                [
                    "aria2.addUri",
                    "aria2.tellStatus",
                    "aria2.tellStatus",
                    "aria2.changeOption",
                ],
                "a child that was never paused must not be unpaused"
            );
        }

        /// A pause that *did* take is the dangerous one. aria2 refuses to
        /// unpause a group until it has finished stopping, and the pause four
        /// lines earlier is what puts it in that state — so a single attempt
        /// loses a race it started, and the download is left stopped with
        /// nothing to start it again. Asking once more is the whole fix.
        #[tokio::test]
        async fn an_unpause_aria2_is_not_ready_for_is_asked_again() {
            let child_files = serde_json::json!([
                {"index": "1", "path": "/mnt/kontent/movies/movie.mkv", "length": "100", "selected": "true"},
            ]);
            let mock = mock_server_with(
                serde_json::json!({"result": "metadata-gid"}),
                MetadataOutcome::ResolvesWithChild {
                    child_gid: "child-gid".to_string(),
                    child_files,
                },
                "paused",
                2,
            )
            .await;
            let state = test_state(mock.url);

            add(State(state), CurrentSession(session()), Form(add_form())).await;

            wait_for_calls(&mock.calls, 7).await;
            assert_eq!(
                mock.calls
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|m| *m == "aria2.unpause")
                    .count(),
                3,
                "the add gave up on its own pause"
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
            assert_eq!(body["addStatus"], "error");
            assert!(
                body["addMessage"].as_str().is_some_and(|m| !m.is_empty()),
                "the rejection has to say something, got {body}"
            );
        }
    }

    /// The row a resolving magnet is shown as, once the marker is stripped.
    /// Nothing about the state should read as an implementation detail — and
    /// it must not change with the connection count, which on a metadata pass
    /// oscillates off DHT peers that have nothing (see `Health::Resolving`).
    #[test]
    fn a_resolving_magnet_is_named_without_the_marker_and_holds_one_state() {
        let metadata = Download {
            gid: "m1".to_string(),
            bittorrent_name: Some("[METADATA]abc123".to_string()),
            ..Download::fixture()
        };
        let row = Row::new(&metadata, Vec::new(), false);
        assert_eq!(row.name, "abc123", "the marker should not be on screen");
        assert_eq!(row.state, "finding peers");
        assert!(
            row.percent.is_none(),
            "nothing is known about size yet, so the bar is indeterminate"
        );

        let with_peers = Download {
            connections: 4,
            ..metadata
        };
        assert_eq!(
            Row::new(&with_peers, Vec::new(), false).state,
            "finding peers"
        );
    }

    /// aria2 marks the metadata-only pass with this literal prefix for as
    /// long as it exists. It is swept from the stopped list, where it lingers
    /// forever after the real download has taken over — but *not* from the
    /// active one, where it is the only evidence an add happened at all.
    #[test]
    fn metadata_only_rows_are_recognised_by_name_and_real_ones_are_not() {
        let metadata = Download {
            status: Status::Complete,
            bittorrent_name: Some("[METADATA]Some.Show.S01".to_string()),
            ..Download::fixture()
        };
        assert!(metadata.is_metadata());

        let real = Download {
            bittorrent_name: Some("Some.Show.S01".to_string()),
            ..metadata
        };
        assert!(!real.is_metadata());
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

    /// An aria2 that refuses the removal calls the way the real one does. The
    /// mock in `scripts/mock-aria2.ts` deletes on any of them and so could
    /// never have shown this: aria2 accepts `remove` only for a download it is
    /// still running and `removeDownloadResult` only for one it has already
    /// stopped, and it does not move between those the instant it is asked.
    mod remove_flow {
        use std::sync::{Arc, Mutex};
        use std::time::Duration as StdDuration;

        use axum::Json;
        use axum::extract::State as AxumState;
        use axum::routing::post;

        use crate::auth::session::Session;

        use super::*;

        #[derive(Clone)]
        struct MockAria2 {
            /// `None` once aria2 has forgotten it, which is what `clear` polls
            /// the lists for.
            status: Arc<Mutex<Option<&'static str>>>,
            /// `removeDownloadResult` calls to refuse before it takes — aria2
            /// refuses one for a download still on its way to the stopped list.
            discard_refusals: Arc<Mutex<u32>>,
            calls: Arc<Mutex<Vec<String>>>,
        }

        fn error(message: &str) -> serde_json::Value {
            serde_json::json!({"error": {"code": 1, "message": message}})
        }

        fn download(gid: &str, status: &str) -> serde_json::Value {
            serde_json::json!({
                "gid": gid,
                "status": status,
                "totalLength": "100",
                "completedLength": "100",
                "downloadSpeed": "0",
                "uploadSpeed": "0",
                "connections": "0",
                "dir": "/mnt/kontent/movies",
                "files": [],
            })
        }

        async fn rpc(
            AxumState(mock): AxumState<MockAria2>,
            Json(body): Json<serde_json::Value>,
        ) -> Json<serde_json::Value> {
            let method = body["method"].as_str().unwrap_or_default().to_string();
            mock.calls.lock().unwrap().push(method.clone());
            let mut status = mock.status.lock().unwrap();
            let stopped = |s: &str| matches!(s, "complete" | "error" | "removed");
            let response = match method.as_str() {
                "aria2.tellStatus" => match *status {
                    Some(s) => serde_json::json!({"result": download("g1", s)}),
                    None => error("No such download"),
                },
                "aria2.tellActive" => match *status {
                    Some("active") => serde_json::json!({"result": [download("g1", "active")]}),
                    _ => serde_json::json!({"result": []}),
                },
                "aria2.tellWaiting" => serde_json::json!({"result": []}),
                "aria2.tellStopped" => match *status {
                    Some(s) if stopped(s) => serde_json::json!({"result": [download("g1", s)]}),
                    _ => serde_json::json!({"result": []}),
                },
                "aria2.remove" | "aria2.forceRemove" => match *status {
                    Some(s) if !stopped(s) => {
                        *status = Some("removed");
                        serde_json::json!({"result": "g1"})
                    }
                    _ => error("GID#g1 cannot be removed now"),
                },
                "aria2.removeDownloadResult" => {
                    let mut refusals = mock.discard_refusals.lock().unwrap();
                    match *status {
                        Some(s) if stopped(s) && *refusals == 0 => {
                            *status = None;
                            serde_json::json!({"result": "OK"})
                        }
                        _ => {
                            *refusals = refusals.saturating_sub(1);
                            error("GID#g1 is not found")
                        }
                    }
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
            status: Arc<Mutex<Option<&'static str>>>,
            calls: Arc<Mutex<Vec<String>>>,
        }

        async fn mock_server(status: &'static str, discard_refusals: u32) -> Mock {
            let mock = MockAria2 {
                status: Arc::new(Mutex::new(Some(status))),
                discard_refusals: Arc::new(Mutex::new(discard_refusals)),
                calls: Arc::new(Mutex::new(Vec::new())),
            };
            let app = axum::Router::new()
                .route("/", post(rpc))
                .with_state(mock.clone());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            Mock {
                url: format!("http://{addr}/"),
                status: mock.status,
                calls: mock.calls,
            }
        }

        fn session() -> Session {
            Session {
                id: "s".to_string(),
                sub: "tester".to_string(),
                expires: std::time::Instant::now() + StdDuration::from_secs(60),
            }
        }

        async fn wait_until_gone(mock: &Mock) -> bool {
            for _ in 0..400 {
                if mock.status.lock().unwrap().is_none() {
                    return true;
                }
                tokio::time::sleep(StdDuration::from_millis(10)).await;
            }
            false
        }

        /// The bug behind #316. aria2 refuses `remove` for a download it has
        /// already stopped — every errored row, and any finished torrent it is
        /// no longer seeding — so the handler failed on the first call and
        /// never reached `removeDownloadResult`, which would have worked. The
        /// row stayed, the press showed nothing, and the next press failed
        /// identically.
        #[tokio::test]
        async fn a_download_aria2_has_already_stopped_is_still_discarded() {
            for status in ["complete", "error"] {
                let mock = mock_server(status, 0).await;
                let state = state(mock.url.clone());
                remove(
                    State(state.clone()),
                    CurrentSession(session()),
                    Path("g1".to_string()),
                )
                .await
                .expect("removing a stopped download must not fail");
                assert!(
                    wait_until_gone(&mock).await,
                    "a {status} download was left in aria2's list"
                );
            }
        }

        /// aria2 is not done when `remove` returns: the download has to reach
        /// the stopped list before `removeDownloadResult` will take it. One
        /// attempt left the corpse behind, where it rendered as a live row.
        ///
        /// The response is the end of the whole thing now, so nothing here has
        /// to wait for a detached task to catch up.
        #[tokio::test]
        async fn a_removal_keeps_asking_until_aria2_has_actually_let_go() {
            let mock = mock_server("active", 3).await;
            let state = state(mock.url.clone());
            state.activity.record("g1", "added");

            remove(
                State(state.clone()),
                CurrentSession(session()),
                Path("g1".to_string()),
            )
            .await
            .expect("removing an active download must not fail");

            assert!(
                mock.status.lock().unwrap().is_none(),
                "the response came back before aria2 had let go"
            );
            assert!(!state.clearing.contains("g1"), "the mark was never lifted");
            assert!(
                state.activity.entries("g1").is_empty(),
                "a download nothing will render again keeps no history"
            );
            let calls = mock.calls.lock().unwrap();
            assert!(
                calls
                    .iter()
                    .filter(|m| *m == "aria2.removeDownloadResult")
                    .count()
                    > 1,
                "one attempt is what left the corpse behind: {calls:?}"
            );
        }

        /// Stopping is `forceRemove` — the graceful `remove` announces to every
        /// tracker and waits for the peers to go, which is the wait the held
        /// response cannot afford and the press has already decided against.
        #[tokio::test]
        async fn stopping_a_running_download_does_not_wait_for_the_swarm() {
            let mock = mock_server("active", 0).await;
            let state = state(mock.url.clone());
            remove(
                State(state.clone()),
                CurrentSession(session()),
                Path("g1".to_string()),
            )
            .await
            .expect("removing an active download must not fail");

            let calls = mock.calls.lock().unwrap();
            assert!(
                calls.iter().any(|m| m == "aria2.forceRemove"),
                "nothing forced the stop: {calls:?}"
            );
            assert!(
                !calls.iter().any(|m| m == "aria2.remove"),
                "the graceful call is the wait this avoids: {calls:?}"
            );
        }

        /// A removal that does not take is a row that is still there, and
        /// answering 204 over it is the silence #354 was about. The mark comes
        /// off either way — the controls it hid have to come back.
        #[tokio::test]
        async fn a_removal_aria2_refuses_answers_with_an_error_and_hands_the_row_back() {
            let mock = mock_server("active", u32::MAX).await;
            let state = state(mock.url.clone());
            let err = remove(
                State(state.clone()),
                CurrentSession(session()),
                Path("g1".to_string()),
            )
            .await
            .expect_err("a removal that never took must not answer 204");
            assert!(matches!(err, AppError::Upstream(_)), "{err:?}");
            assert!(!state.clearing.contains("g1"), "the mark was never lifted");
        }

        /// The press has to be visible before aria2 answers, or it reads as
        /// nothing having happened — which is the whole complaint. Every other
        /// page open on the same download reads the mark, not this request's
        /// response, so it is set for the whole time the request is in flight.
        #[tokio::test]
        async fn the_row_is_marked_clearing_while_the_removal_is_still_in_flight() {
            // Refuses for the whole attempt budget, so the request is still
            // open while this asserts against it.
            let mock = mock_server("active", u32::MAX).await;
            let state = state(mock.url.clone());
            let in_flight = tokio::spawn({
                let state = state.clone();
                async move {
                    remove(
                        State(state),
                        CurrentSession(session()),
                        Path("g1".to_string()),
                    )
                    .await
                }
            });

            let mut marked = false;
            for _ in 0..200 {
                if state.clearing.contains("g1") {
                    marked = true;
                    break;
                }
                tokio::time::sleep(StdDuration::from_millis(5)).await;
            }
            assert!(marked, "the press was invisible until the removal finished");

            let downloads = all_downloads(&state).await.expect("aria2 answers");
            let row = rows(&state, &downloads)
                .into_iter()
                .find(|r| r.gid == "g1")
                .expect("the row is still there while aria2 holds on");
            assert_eq!(row.state, "clearing");
            assert!(row.clearing);

            in_flight.await.expect("the handler ran to completion").ok();
        }
    }
}
