//! The typed face of aria2's JSON-RPC.
//!
//! aria2 answers in strings throughout — progress is a decimal string, counts
//! are integer strings, and an absent field means "not a torrent" rather than
//! zero. Converting once, here, is what keeps that out of the rest of the
//! program: nothing above this module parses a number out of a response.
//!
//! There is no state on this side. aria2 holds the queue, so a restart re-reads
//! reality instead of reconciling with it.

use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;

use crate::error::{AppError, AppResult};

/// How long any one call gets before it is a failure rather than a wait.
///
/// Every mutation the page can ask for is held open until aria2 answers it, so
/// an unbounded call is a button that spins forever — and there is nothing here
/// that aria2 answers slowly. A `tellStatus` or a `forceRemove` is a hash
/// lookup over a loopback socket in the same pod; anything near this ceiling is
/// a sidecar that has stopped answering, which is worth saying rather than
/// waiting out.
const RPC_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct Aria2 {
    url: Arc<String>,
    http: reqwest::Client,
}

/// What a download is doing, as aria2 reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Active,
    Waiting,
    Paused,
    Error,
    Complete,
    Removed,
}

impl FromStr for Status {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, ()> {
        Ok(match s {
            "active" => Status::Active,
            "waiting" => Status::Waiting,
            "paused" => Status::Paused,
            "error" => Status::Error,
            "complete" => Status::Complete,
            "removed" => Status::Removed,
            _ => return Err(()),
        })
    }
}

/// How a download is faring, which is a different question from what it is
/// doing. These are not degrees of one thing — each names a different problem
/// with a different answer, which is why the row shows the state rather than
/// just a percentage.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Health {
    /// Behind `maxConcurrentDownloads`. Nothing is wrong and nothing is
    /// happening — which is the one thing the old catch-all could not say,
    /// so a queued torrent read as "no seeders" and looked broken.
    Queued,
    /// The magnet has not resolved: aria2 is looking for peers who will serve
    /// the torrent file, and asking whichever it finds.
    ///
    /// This was briefly split in two on `connections > 0`, on the theory that
    /// peers connected meant metadata was on its way. Watching a real dead
    /// magnet disproved it — DHT hands out peers that have never heard of the
    /// infohash, so the count oscillates between zero and a handful every few
    /// seconds while nothing whatsoever arrives. The split named that
    /// oscillation "progress", and flapped the badge and the activity log
    /// along with it. Nothing in a single `tellStatus` separates a magnet
    /// nobody has from one that is merely slow; what separates them is how
    /// long it has been, which is what the timestamps in the log are for.
    Resolving,
    /// aria2 is hashing what is already on disk before downloading anything —
    /// a resumed download, or one whose files were already there. Reads as
    /// zero speed with peers connected, which is otherwise indistinguishable
    /// from stalled.
    Verifying,
    /// Bytes are arriving.
    Moving,
    /// Peers connected, nothing arriving. May recover on its own.
    Choked,
    /// Seeders exist and none is connected — a local problem, and the one worth
    /// acting on. Ordinary in a sparse swarm whenever the peer port is not
    /// forwarded, since an unreachable client can only ever dial out.
    Blocked,
    /// No seeders. Nothing to wait for; the fix is a different magnet.
    Dead,
    Paused,
    /// Every wanted byte has arrived. Seeding continues, and it is still
    /// "active" to aria2 — but it is watchable, which is what the row means.
    Complete,
    Errored,
}

/// aria2's numeric reason for stopping, in words.
///
/// `errorMessage` is the obvious place to look and is routinely empty — aria2
/// fills it in for some failures and not others, and a row that failed with no
/// message at all was the common shape of "it broke and nothing says why".
/// The code is always there. Only the ones reachable from a magnet are named;
/// anything else keeps its number, which is still a thing to search for.
pub fn error_code_meaning(code: u32) -> Option<&'static str> {
    Some(match code {
        1 => "unknown error",
        2 => "timed out",
        3 => "the resource was not found",
        4 => "gave up after too many missing files",
        5 => "too slow, and aria2 gave up",
        6 => "network problem",
        7 => "stopped with downloads still unfinished",
        8 => "the server does not support resuming",
        9 => "not enough disk space",
        10 => "piece length differs from the control file",
        11 => "the same file is already downloading",
        12 => "this torrent is already downloading",
        13 => "the file already exists",
        14 => "renaming the file failed",
        15 => "could not open the file",
        16 => "could not create the file",
        17 => "reading or writing the file failed",
        18 => "could not create the directory",
        19 => "name resolution failed",
        25 => "could not parse the torrent",
        26 => "the torrent file is corrupt",
        27 => "the magnet link is bad",
        28 => "a bad or unrecognised option",
        29 => "the server is overloaded or down for maintenance",
        32 => "checksum mismatch",
        _ => return None,
    })
}

#[derive(Clone, Debug)]
pub struct File {
    /// 1-based, as `select-file` wants it.
    pub index: u32,
    pub path: String,
    pub length: u64,
    pub completed_length: u64,
    /// `false` for a file `select-file` left out — aria2 still downloads
    /// whole pieces regardless, so a small deselected file sharing a piece
    /// boundary with a selected one can still land on disk. This is what
    /// tells the completion sweep (`notify::sweep_garbage`) which files were
    /// never meant to be there in the first place, as opposed to one that
    /// simply happens to be small.
    pub selected: bool,
}

impl From<RawFile> for File {
    fn from(f: RawFile) -> Self {
        File {
            index: f.index.parse().unwrap_or(0),
            path: f.path,
            length: f.length.parse().unwrap_or(0),
            completed_length: f.completed_length.parse().unwrap_or(0),
            selected: f.selected == "true",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Download {
    pub gid: String,
    pub status: Status,
    pub total_length: u64,
    pub completed_length: u64,
    /// Bytes sent to the swarm over this download's life, which is what a
    /// share ratio is computed from — not `upload_speed`, an instantaneous
    /// reading that says nothing about what has been given back.
    pub upload_length: u64,
    pub download_speed: u64,
    pub upload_speed: u64,
    pub connections: u32,
    pub num_seeders: u32,
    pub error_message: Option<String>,
    /// aria2's numeric reason for stopping, which it reports on stopped and
    /// completed downloads. `None` on a download that has not stopped, and on
    /// one that stopped successfully — aria2 reports `0` there, and a success
    /// code sitting in an error field is worse than no code at all.
    pub error_code: Option<u32>,
    pub dir: String,
    pub files: Vec<File>,
    pub piece_length: u64,
    pub num_pieces: u32,
    /// Bytes hashed so far, present only while aria2 is checking existing data
    /// — so its presence, not its value, is what says a check is running.
    pub verified_length: Option<u64>,
    /// Queued for a hash check that has not started.
    pub verify_integrity_pending: bool,
    pub info_hash: Option<String>,
    /// The torrent's own name, once metadata has arrived.
    pub bittorrent_name: Option<String>,
    /// Gids of downloads aria2 generated from this one. A `bt-metadata-only`
    /// pass has exactly one once its metadata resolves: the real download,
    /// spawned by `follow-torrent`, with the torrent's actual file list —
    /// which the metadata gid's own `files` (one entry: itself) is not.
    pub followed_by: Vec<String>,
}

impl Download {
    pub fn name(&self) -> &str {
        if let Some(name) = &self.bittorrent_name {
            return name;
        }
        if let Some(basename) = self.files.first().and_then(|f| f.path.rsplit('/').next())
            && !basename.is_empty()
        {
            return basename;
        }
        &self.gid
    }

    /// Sum of `length` and `completed_length` across only the files aria2
    /// was actually asked for. `None` when there is no selection to sum —
    /// an unresolved magnet's empty file list, or (defensively) a download
    /// with nothing selected at all.
    ///
    /// This exists because `total_length`/`completed_length` on the download
    /// itself are not what they look like once `select-file` is in play:
    /// aria2 does not shrink `total_length` to match a selection — confirmed
    /// against a real daemon, it stays the whole torrent's size — so those
    /// two only ever agree once every byte has arrived, selected or not.
    /// Each file's own `length`/`completed_length` carry no such ambiguity.
    pub fn selected_totals(&self) -> Option<(u64, u64)> {
        let selected: Vec<&File> = self.files.iter().filter(|f| f.selected).collect();
        if selected.is_empty() {
            return None;
        }
        let total = selected.iter().map(|f| f.length).sum();
        let done = selected.iter().map(|f| f.completed_length).sum();
        Some((total, done))
    }

    /// What the row prints for size and progress, from one source.
    ///
    /// The bar was drawn from the selected files and the bytes beside it from
    /// aria2's download-level counters, which are not the same number: aria2
    /// never shrinks `total_length` to a selection, so a torrent with one file
    /// of four chosen showed the whole torrent's size next to a bar tracking
    /// only the chosen one. Falls back to the download-level counters, which
    /// is right until the file list arrives and nothing else can answer.
    pub fn display_totals(&self) -> (u64, u64) {
        self.selected_totals()
            .unwrap_or((self.total_length, self.completed_length))
    }

    /// What the bar is drawn from, and the bytes printed beside it.
    ///
    /// A hash check has progress of its own, and it is not the download's.
    /// aria2 counts every piece in the control file as complete before it
    /// starts hashing, so through the whole check `display_totals` reads full
    /// for a restored seed and frozen for a restored partial, while
    /// `verifiedLength` climbs from zero to the total — measured at the
    /// poller's own rate on a real restore, 57MB to 762MB in 1.4s on an SSD,
    /// and the same read is minutes on the disks this actually runs on. So a
    /// bar tracking downloaded bytes is a bar that does not move for the one
    /// wait it was most wanted for.
    ///
    /// Capped at the total: aria2 hashes whole pieces, so a selective torrent
    /// can verify past the size of the files it chose, and a bar over 100% is
    /// worse than one that saturates.
    pub fn progress_totals(&self) -> (u64, u64) {
        let (total, done) = self.display_totals();
        match self.verified_length {
            Some(verified) => (total, verified.min(total)),
            None => (total, done),
        }
    }

    /// `None` until the magnet resolves, which a `<progress>` with no value
    /// renders as indeterminate. That is the honest rendering: with
    /// `total_length` at zero a percentage is a division by zero, and
    /// "resolving the magnet" is a different state from "downloading nothing".
    pub fn percent(&self) -> Option<f64> {
        let (total, done) = self.progress_totals();
        if total == 0 {
            return None;
        }
        Some(done as f64 / total as f64 * 100.0)
    }

    pub fn is_metadata(&self) -> bool {
        self.name().starts_with("[METADATA]")
    }

    /// `None` when nothing is moving — an ETA with zero speed is infinity, and
    /// one taken off a collapsing rate is misleading.
    pub fn eta_secs(&self) -> Option<u64> {
        if self.download_speed == 0 || self.is_finished() {
            return None;
        }
        let (total, done) = self.display_totals();
        total
            .checked_sub(done)
            .map(|left| left / self.download_speed)
    }

    /// Share ratio. With no ratio limit (`--seed-ratio=0.0`), this is just
    /// the only way to tell if a torrent is actually seeding.
    pub fn ratio(&self) -> Option<f64> {
        let (_, done) = self.display_totals();
        (done > 0).then(|| self.upload_length as f64 / done as f64)
    }

    pub fn health(&self) -> Health {
        // Status first: paused and errored are decisions made about the
        // download, not observations of its traffic, so they outrank
        // whatever the speed and seeder counts happen to say. Only after all
        // of that does the question become "why is nothing moving", which is
        // what the rest of the branches diagnose in order from most to least
        // fixable locally.
        if self.status == Status::Error {
            Health::Errored
        } else if self.status == Status::Paused {
            Health::Paused
        } else if self.verify_integrity_pending || self.verified_length.is_some() {
            // Ahead of every traffic reading below, because a hash check runs
            // at zero download speed with peers still connected, which those
            // would diagnose as stalled — and ahead of `is_finished`, which
            // otherwise answers for the case the check matters most in.
            // aria2 counts every piece in the control file as complete before
            // it starts hashing them, so a restored *seeding* torrent reads
            // as fully downloaded for the entire check and said "downloaded"
            // through the longest wait a deploy has: re-reading gigabytes off
            // a mechanical disk.
            Health::Verifying
        } else if self.is_finished() {
            Health::Complete
        } else if self.status == Status::Waiting {
            Health::Queued
        } else if self.is_metadata() || self.total_length == 0 {
            Health::Resolving
        } else if self.download_speed > 0 {
            Health::Moving
        } else if self.connections > 0 {
            Health::Choked
        } else if self.num_seeders > 0 {
            Health::Blocked
        } else {
            Health::Dead
        }
    }

    /// Finished *for display*. With `--seed-ratio=0.0`, status never reaches
    /// Complete on its own, and aggregate byte counts lie with selections. A
    /// torrent is finished when all *selected* files are done.
    pub fn is_finished(&self) -> bool {
        if self.status == Status::Complete {
            return true;
        }
        let (total, done) = self
            .selected_totals()
            .unwrap_or((self.total_length, self.completed_length));
        total > 0 && done >= total
    }

    /// aria2 has stopped it (error, complete, or removed). Decides which of
    /// the two removal calls applies: `remove` for active, `removeDownloadResult`
    /// for stopped.
    pub fn is_stopped(&self) -> bool {
        matches!(
            self.status,
            Status::Complete | Status::Error | Status::Removed
        )
    }
}

#[cfg(test)]
impl Download {
    pub(crate) fn fixture() -> Self {
        Download {
            gid: "gid1".to_string(),
            status: Status::Active,
            total_length: 0,
            completed_length: 0,
            upload_length: 0,
            download_speed: 0,
            upload_speed: 0,
            connections: 0,
            num_seeders: 0,
            error_message: None,
            error_code: None,
            dir: "/mnt/kontent/movies".to_string(),
            files: Vec::new(),
            piece_length: 0,
            num_pieces: 0,
            verified_length: None,
            verify_integrity_pending: false,
            info_hash: None,
            bittorrent_name: None,
            followed_by: Vec::new(),
        }
    }
}

/// aria2's wire shape — everything is a string, some fields are optional.
#[derive(Deserialize, Default)]
struct RawDownload {
    #[serde(default)]
    gid: String,
    #[serde(default)]
    status: String,
    #[serde(default, rename = "totalLength")]
    total_length: String,
    #[serde(default, rename = "completedLength")]
    completed_length: String,
    #[serde(default, rename = "uploadLength")]
    upload_length: String,
    #[serde(default, rename = "downloadSpeed")]
    download_speed: String,
    #[serde(default, rename = "uploadSpeed")]
    upload_speed: String,
    #[serde(default)]
    connections: String,
    #[serde(default, rename = "numSeeders")]
    num_seeders: Option<String>,
    #[serde(default, rename = "errorMessage")]
    error_message: Option<String>,
    #[serde(default, rename = "errorCode")]
    error_code: Option<String>,
    #[serde(default)]
    dir: String,
    #[serde(default)]
    files: Vec<RawFile>,
    #[serde(default, rename = "pieceLength")]
    piece_length: String,
    #[serde(default, rename = "numPieces")]
    num_pieces: String,
    // Both absent unless a hash check is pending or running — which is the
    // whole signal, so neither may default to a value that looks like one.
    #[serde(default, rename = "verifiedLength")]
    verified_length: Option<String>,
    #[serde(default, rename = "verifyIntegrityPending")]
    verify_integrity_pending: Option<String>,
    #[serde(default, rename = "infoHash")]
    info_hash: Option<String>,
    #[serde(default)]
    bittorrent: Option<RawBittorrent>,
    #[serde(default, rename = "followedBy")]
    followed_by: Vec<String>,
}

#[derive(Deserialize, Default)]
struct RawFile {
    #[serde(default)]
    index: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    length: String,
    #[serde(default, rename = "completedLength")]
    completed_length: String,
    #[serde(default)]
    selected: String,
}

#[derive(Deserialize, Default)]
struct RawBittorrent {
    #[serde(default)]
    info: Option<RawBtInfo>,
}

#[derive(Deserialize, Default)]
struct RawBtInfo {
    #[serde(default)]
    name: Option<String>,
}

impl RawDownload {
    /// Numeric fields default to 0; only an unrecognized status fails the download.
    fn into_download(self) -> AppResult<Download> {
        let status = self.status.parse::<Status>().map_err(|_| {
            AppError::Upstream(format!("aria2: unrecognised status {:?}", self.status))
        })?;
        let bittorrent_name = self.bittorrent.and_then(|b| b.info).and_then(|i| i.name);
        Ok(Download {
            gid: self.gid,
            status,
            total_length: self.total_length.parse().unwrap_or(0),
            completed_length: self.completed_length.parse().unwrap_or(0),
            upload_length: self.upload_length.parse().unwrap_or(0),
            download_speed: self.download_speed.parse().unwrap_or(0),
            upload_speed: self.upload_speed.parse().unwrap_or(0),
            connections: self.connections.parse().unwrap_or(0),
            num_seeders: self.num_seeders.and_then(|s| s.parse().ok()).unwrap_or(0),
            error_message: self.error_message,
            // aria2 reports `0` for a download that stopped successfully, and
            // a success code carried in a field named for errors is how a
            // finished torrent ends up explaining itself as a failure.
            error_code: self
                .error_code
                .and_then(|c| c.parse::<u32>().ok())
                .filter(|c| *c != 0),
            dir: self.dir,
            files: self.files.into_iter().map(File::from).collect(),
            piece_length: self.piece_length.parse().unwrap_or(0),
            num_pieces: self.num_pieces.parse().unwrap_or(0),
            verified_length: self.verified_length.and_then(|v| v.parse().ok()),
            verify_integrity_pending: self.verify_integrity_pending.as_deref() == Some("true"),
            info_hash: self.info_hash,
            bittorrent_name,
            followed_by: self.followed_by,
        })
    }
}

fn parse_download(value: serde_json::Value) -> AppResult<Download> {
    let raw: RawDownload =
        serde_json::from_value(value).map_err(|e| AppError::Upstream(format!("aria2: {e}")))?;
    raw.into_download()
}

fn parse_downloads(value: serde_json::Value) -> AppResult<Vec<Download>> {
    let raws: Vec<RawDownload> =
        serde_json::from_value(value).map_err(|e| AppError::Upstream(format!("aria2: {e}")))?;
    raws.into_iter().map(RawDownload::into_download).collect()
}

#[derive(Deserialize)]
struct RpcError {
    message: String,
}

#[derive(Deserialize, Default)]
struct RpcResponse {
    #[serde(default)]
    result: Option<serde_json::Value>,
    #[serde(default)]
    error: Option<RpcError>,
}

impl Aria2 {
    pub fn new(url: String, http: reqwest::Client) -> Self {
        Self {
            url: Arc::new(url),
            http,
        }
    }

    /// One JSON-RPC round trip. Every method below is this plus a shape.
    async fn call(&self, method: &str, params: serde_json::Value) -> AppResult<serde_json::Value> {
        let full_method = format!("aria2.{method}");
        tracing::debug!(method = %full_method, "aria2 rpc call");
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": "mariastew",
            "method": full_method,
            "params": params,
        });
        let response = self
            .http
            .post(self.url.as_str())
            .timeout(RPC_TIMEOUT)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Upstream(e.to_string()))?;
        let response: RpcResponse = response
            .json()
            .await
            .map_err(|e| AppError::Upstream(e.to_string()))?;
        if let Some(error) = response.error {
            return Err(AppError::Upstream(error.message));
        }
        response.result.ok_or_else(|| {
            AppError::Upstream("aria2: response carried neither result nor error".to_string())
        })
    }

    /// Returns the gid. `options` is passed through as aria2's option object,
    /// which is how the caller asks for a metadata-only pass or names the
    /// destination and the wanted file indices.
    pub async fn add_uri(&self, uri: &str, options: serde_json::Value) -> AppResult<String> {
        let result = self
            .call("addUri", serde_json::json!([[uri], options]))
            .await?;
        serde_json::from_value(result).map_err(|e| AppError::Upstream(format!("aria2: {e}")))
    }

    pub async fn tell_status(&self, gid: &str) -> AppResult<Download> {
        let result = self.call("tellStatus", serde_json::json!([gid])).await?;
        parse_download(result)
    }

    pub async fn tell_active(&self) -> AppResult<Vec<Download>> {
        let result = self.call("tellActive", serde_json::json!([])).await?;
        parse_downloads(result)
    }

    pub async fn tell_waiting(&self, offset: i32, num: i32) -> AppResult<Vec<Download>> {
        let result = self
            .call("tellWaiting", serde_json::json!([offset, num]))
            .await?;
        parse_downloads(result)
    }

    pub async fn tell_stopped(&self, offset: i32, num: i32) -> AppResult<Vec<Download>> {
        let result = self
            .call("tellStopped", serde_json::json!([offset, num]))
            .await?;
        parse_downloads(result)
    }

    pub async fn pause(&self, gid: &str) -> AppResult<()> {
        self.call("pause", serde_json::json!([gid])).await?;
        Ok(())
    }

    pub async fn unpause(&self, gid: &str) -> AppResult<()> {
        self.call("unpause", serde_json::json!([gid])).await?;
        Ok(())
    }

    /// Stop it now. `forceRemove`, not `remove`: the graceful one announces the
    /// stop to every tracker and waits for the peers to go before the download
    /// leaves the active list, and the press that reaches here is someone who
    /// has already decided — held open while it happens. Trying `remove` first
    /// and falling back bought the polite version at the cost of that wait plus
    /// a failed call on every download aria2 had already stopped.
    ///
    /// aria2 refuses this for a download that is already stopped, which is what
    /// `remove_download_result` is for.
    pub async fn remove(&self, gid: &str) -> AppResult<()> {
        self.call("forceRemove", serde_json::json!([gid])).await?;
        Ok(())
    }

    /// Clears the corpse out of the stopped list. Without this a removed
    /// download stays in `tellStopped` and the list fills up with them.
    pub async fn remove_download_result(&self, gid: &str) -> AppResult<()> {
        self.call("removeDownloadResult", serde_json::json!([gid]))
            .await?;
        Ok(())
    }

    /// Changes options on a download already added — `dir` and `select-file`
    /// among them, which is how a torrent's real destination and file
    /// selection get set on the download `follow-torrent` spawned from a
    /// resolved magnet, rather than on a second `addUri` racing its infohash.
    /// aria2 restarts the download internally to apply it; no second gid, no
    /// caller-visible interruption.
    pub async fn change_option(&self, gid: &str, options: serde_json::Value) -> AppResult<()> {
        self.call("changeOption", serde_json::json!([gid, options]))
            .await?;
        Ok(())
    }

    /// Whether `select-file` has been set on this download.
    ///
    /// The one durable mark that an add finished. aria2 holds it — nothing on
    /// this side does — and it is written exactly once, by
    /// `routes::finish_add_inner`, at the end of the sequence that narrows a
    /// download to the files worth keeping. So its absence says the add did
    /// not get that far, and `resume` reads it to tell a download waiting to
    /// be finished from one somebody deliberately paused.
    ///
    /// Absent rather than empty when unset: aria2 omits the key from
    /// `getOption` entirely, which is why this answers a bool rather than
    /// handing back a string nobody would know how to read.
    pub async fn has_selection(&self, gid: &str) -> AppResult<bool> {
        let options = self.call("getOption", serde_json::json!([gid])).await?;
        Ok(options
            .get("select-file")
            .and_then(|v| v.as_str())
            .is_some_and(|v| !v.is_empty()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn download(status: Status) -> Download {
        Download {
            status,
            ..Download::fixture()
        }
    }

    #[test]
    fn a_torrent_response_parses() {
        let value = serde_json::json!({
            "gid": "abc123",
            "status": "active",
            "totalLength": "1048576",
            "completedLength": "524288",
            "downloadSpeed": "1024",
            "uploadSpeed": "0",
            "connections": "3",
            "numSeeders": "5",
            "dir": "/downloads",
            "files": [
                {"index": "1", "path": "/downloads/Movie.mkv", "length": "1048576", "selected": "true"},
                {"index": "2", "path": "/downloads/Movie.nfo", "length": "0", "selected": "false"},
            ],
            "bittorrent": {"info": {"name": "Movie"}},
        });
        let d = parse_download(value).unwrap();
        assert_eq!(d.gid, "abc123");
        assert_eq!(d.status, Status::Active);
        assert_eq!(d.total_length, 1_048_576);
        assert_eq!(d.completed_length, 524_288);
        assert_eq!(d.download_speed, 1024);
        assert_eq!(d.connections, 3);
        assert_eq!(d.num_seeders, 5);
        assert_eq!(d.bittorrent_name.as_deref(), Some("Movie"));
        assert_eq!(d.files.len(), 2);
        assert_eq!(d.files[0].index, 1);
        assert!(d.files[0].selected);
        assert_eq!(d.files[1].index, 2);
        assert!(!d.files[1].selected);
    }

    #[test]
    fn a_non_torrent_response_has_no_bittorrent_and_zero_seeders() {
        let value = serde_json::json!({
            "gid": "abc123",
            "status": "active",
            "totalLength": "100",
            "completedLength": "50",
            "downloadSpeed": "0",
            "uploadSpeed": "0",
            "connections": "1",
            "dir": "/downloads",
            "files": [],
        });
        let d = parse_download(value).unwrap();
        assert_eq!(d.num_seeders, 0);
        assert!(d.bittorrent_name.is_none());
    }

    #[test]
    fn percent_is_none_at_zero_total() {
        let mut d = download(Status::Active);
        d.total_length = 0;
        assert_eq!(d.percent(), None);
    }

    #[test]
    fn percent_is_the_completed_fraction() {
        let mut d = download(Status::Active);
        d.total_length = 200;
        d.completed_length = 50;
        assert_eq!(d.percent(), Some(25.0));
    }

    #[test]
    fn health_errored() {
        let mut d = download(Status::Error);
        d.total_length = 100;
        assert_eq!(d.health(), Health::Errored);
    }

    #[test]
    fn health_paused() {
        let mut d = download(Status::Paused);
        d.total_length = 100;
        assert_eq!(d.health(), Health::Paused);
    }

    #[test]
    fn health_complete() {
        let mut d = download(Status::Complete);
        d.total_length = 100;
        d.completed_length = 100;
        assert_eq!(d.health(), Health::Complete);
    }

    /// An unresolved magnet is one state, whatever its connection count is
    /// doing. Splitting on `connections` was tried against a real dead magnet
    /// and the count oscillated 0↔4 every few seconds off DHT peers that had
    /// never heard of the infohash — see the note on `Health::Resolving`. A
    /// state that changes twice a minute while nothing happens is worse than
    /// no state at all, because it also floods the activity log.
    #[test]
    fn health_resolving_does_not_flap_with_the_connection_count() {
        let mut d = download(Status::Active);
        assert_eq!(d.health(), Health::Resolving);
        d.connections = 4;
        assert_eq!(d.health(), Health::Resolving);
        d.connections = 0;
        assert_eq!(d.health(), Health::Resolving);
    }

    /// A download aria2 has parked behind `maxConcurrentDownloads` has no
    /// traffic and no peers, which every branch below `Waiting` would read as
    /// a dead swarm.
    #[test]
    fn health_queued_rather_than_diagnosed_as_a_dead_swarm() {
        let mut d = download(Status::Waiting);
        d.total_length = 100;
        assert_eq!(d.health(), Health::Queued);
    }

    /// A hash check also shows zero speed with peers connected — "stalled"
    /// under the traffic branches, and the one state where nothing is wrong
    /// and there is nothing to do but wait.
    #[test]
    fn health_verifying_outranks_the_traffic_reading_it_would_otherwise_get() {
        let mut d = download(Status::Active);
        d.total_length = 100;
        d.connections = 2;
        d.verified_length = Some(0);
        assert_eq!(d.health(), Health::Verifying);

        d.verified_length = None;
        d.verify_integrity_pending = true;
        assert_eq!(d.health(), Health::Verifying);
    }

    /// The case the check matters most in, and the one it used to answer for
    /// last. aria2 counts every piece in the control file as complete before
    /// it starts hashing them, so a restored seeding torrent reads as fully
    /// downloaded for the whole check — and `is_finished` above said
    /// "downloaded" through the longest wait a deploy has.
    #[test]
    fn health_verifying_outranks_a_completion_aria2_has_not_rechecked_yet() {
        let mut d = download(Status::Active);
        d.total_length = 100;
        d.completed_length = 100;
        d.verified_length = Some(30);
        assert_eq!(d.health(), Health::Verifying);

        d.verified_length = None;
        assert_eq!(d.health(), Health::Complete);
    }

    /// The bar has to follow the check, because nothing else about the
    /// download moves while one runs: the byte counters are already at their
    /// final value and `verifiedLength` is the only thing climbing.
    #[test]
    fn the_bar_follows_the_hash_check_while_one_is_running() {
        let mut d = download(Status::Active);
        d.total_length = 100;
        d.completed_length = 100;

        d.verified_length = Some(30);
        assert_eq!(d.progress_totals(), (100, 30));
        assert_eq!(d.percent(), Some(30.0));

        // aria2 hashes whole pieces, so a selective torrent can verify past
        // the size of the files it chose. A saturated bar beats one at 140%.
        d.verified_length = Some(140);
        assert_eq!(d.progress_totals(), (100, 100));

        d.verified_length = None;
        assert_eq!(d.progress_totals(), (100, 100));
    }

    #[test]
    fn eta_is_none_without_a_rate_to_divide_by() {
        let mut d = download(Status::Active);
        d.total_length = 100;
        assert_eq!(d.eta_secs(), None);
    }

    #[test]
    fn eta_is_the_remaining_selected_bytes_over_the_current_rate() {
        let mut d = download(Status::Active);
        d.total_length = 1000;
        d.completed_length = 400;
        d.download_speed = 60;
        assert_eq!(d.eta_secs(), Some(10));
    }

    #[test]
    fn ratio_is_uploaded_over_downloaded_and_absent_before_anything_downloaded() {
        let mut d = download(Status::Active);
        assert_eq!(d.ratio(), None);
        d.total_length = 1000;
        d.completed_length = 500;
        d.upload_length = 250;
        assert_eq!(d.ratio(), Some(0.5));
    }

    /// aria2 reports `errorCode` on completed downloads too, where it is `0`.
    /// Carried through as an error it would explain every finished torrent as
    /// a failure.
    #[test]
    fn a_success_code_is_not_an_error_code() {
        let value = serde_json::json!({
            "gid": "abc123", "status": "complete", "errorCode": "0",
            "totalLength": "100", "completedLength": "100", "downloadSpeed": "0",
            "uploadSpeed": "0", "connections": "0", "dir": "/downloads", "files": [],
        });
        assert_eq!(parse_download(value).unwrap().error_code, None);

        let value = serde_json::json!({
            "gid": "abc123", "status": "error", "errorCode": "9",
            "totalLength": "100", "completedLength": "0", "downloadSpeed": "0",
            "uploadSpeed": "0", "connections": "0", "dir": "/downloads", "files": [],
        });
        assert_eq!(parse_download(value).unwrap().error_code, Some(9));
    }

    /// The reason the table exists: aria2 routinely leaves `errorMessage`
    /// empty, and the code is the only thing left to explain the failure.
    #[test]
    fn the_error_codes_worth_explaining_have_words() {
        assert_eq!(error_code_meaning(9), Some("not enough disk space"));
        assert_eq!(error_code_meaning(27), Some("the magnet link is bad"));
        assert_eq!(error_code_meaning(9999), None);
    }

    #[test]
    fn health_moving() {
        let mut d = download(Status::Active);
        d.total_length = 100;
        d.download_speed = 10;
        assert_eq!(d.health(), Health::Moving);
    }

    #[test]
    fn health_choked() {
        let mut d = download(Status::Active);
        d.total_length = 100;
        d.connections = 2;
        assert_eq!(d.health(), Health::Choked);
    }

    #[test]
    fn health_blocked() {
        let mut d = download(Status::Active);
        d.total_length = 100;
        d.num_seeders = 3;
        assert_eq!(d.health(), Health::Blocked);
    }

    #[test]
    fn health_dead() {
        let mut d = download(Status::Active);
        d.total_length = 100;
        assert_eq!(d.health(), Health::Dead);
    }

    #[test]
    fn is_finished_when_a_seeding_torrent_is_still_marked_active() {
        let mut d = download(Status::Active);
        d.total_length = 100;
        d.completed_length = 100;
        assert!(d.is_finished());
    }

    fn file(index: u32, length: u64, completed_length: u64, selected: bool) -> File {
        File {
            index,
            path: format!("/downloads/file{index}"),
            length,
            completed_length,
            selected,
        }
    }

    /// The bug live evidence exposed: aria2 does not shrink `total_length` to
    /// a `select-file` selection, so `total_length`/`completed_length` stay
    /// the whole torrent's numbers even once every selected file has fully
    /// arrived. A 4K release with a finished film and two never-downloaded
    /// deselected bytes-worth of junk would sit at "not finished" forever
    /// under the old aggregate-only check.
    #[test]
    fn is_finished_when_every_selected_file_is_even_though_deselected_ones_are_not() {
        let mut d = download(Status::Active);
        d.total_length = 1100; // whole torrent: the 1000-byte film + 100 bytes of junk
        d.completed_length = 1000; // only the film ever arrived
        d.files = vec![
            file(1, 1000, 1000, true), // selected, fully downloaded
            file(2, 100, 0, false),    // deselected, never downloaded
        ];
        assert!(d.is_finished());
    }

    #[test]
    fn is_not_finished_while_a_selected_file_is_still_incomplete() {
        let mut d = download(Status::Active);
        d.total_length = 1000;
        d.completed_length = 500;
        d.files = vec![file(1, 1000, 500, true)];
        assert!(!d.is_finished());
    }

    /// A file `select-file` left out is irrelevant to "finished" no matter
    /// how far along its own accidental piece-boundary spillover got —
    /// see `notify::sweep_garbage` for what happens to it instead.
    #[test]
    fn a_fully_spilled_over_deselected_file_does_not_make_an_incomplete_selection_finished() {
        let mut d = download(Status::Active);
        d.total_length = 1100;
        d.completed_length = 600;
        d.files = vec![
            file(1, 1000, 500, true), // selected, half done
            file(2, 100, 100, false), // deselected, fully spilled over anyway
        ];
        assert!(!d.is_finished());
    }

    #[test]
    fn percent_is_computed_from_selected_files_only() {
        let mut d = download(Status::Active);
        d.total_length = 1100;
        d.completed_length = 500;
        d.files = vec![
            file(1, 1000, 500, true), // 50% of the only file that counts
            file(2, 100, 100, false), // fully arrived, but not selected
        ];
        assert_eq!(d.percent(), Some(50.0));
    }

    #[test]
    fn percent_falls_back_to_the_aggregate_when_nothing_is_selected_yet() {
        let mut d = download(Status::Active);
        d.total_length = 100;
        d.completed_length = 25;
        assert_eq!(d.percent(), Some(25.0));
    }

    #[test]
    fn name_falls_back_to_the_first_files_basename_then_the_gid() {
        let mut d = download(Status::Active);
        assert_eq!(d.name(), "gid1");

        d.files.push(File {
            index: 1,
            path: "/downloads/Show/S01E01.mkv".to_string(),
            length: 0,
            completed_length: 0,
            selected: true,
        });
        assert_eq!(d.name(), "S01E01.mkv");

        d.bittorrent_name = Some("Show S01".to_string());
        assert_eq!(d.name(), "Show S01");
    }
}
