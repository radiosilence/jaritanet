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

use serde::Deserialize;

use crate::error::{AppError, AppResult};

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
    /// The magnet has not resolved yet, so there is no size and no percentage.
    Resolving,
    /// Bytes are arriving.
    Moving,
    /// Peers connected, nothing arriving. May recover on its own.
    Choked,
    /// Seeders exist and none is connected — a local problem, and the one worth
    /// acting on. Also the ordinary state of a sparse swarm here, because the
    /// home network forwards no port and so accepts no incoming peer.
    Blocked,
    /// No seeders. Nothing to wait for; the fix is a different magnet.
    Dead,
    Paused,
    /// Every wanted byte has arrived. Seeding continues, and it is still
    /// "active" to aria2 — but it is watchable, which is what the row means.
    Complete,
    Errored,
}

#[derive(Clone, Debug)]
pub struct File {
    /// 1-based, as `select-file` wants it.
    pub index: u32,
    pub path: String,
    pub length: u64,
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
    pub download_speed: u64,
    pub upload_speed: u64,
    pub connections: u32,
    pub num_seeders: u32,
    pub error_message: Option<String>,
    pub dir: String,
    pub files: Vec<File>,
    /// The torrent's own name, once metadata has arrived.
    pub bittorrent_name: Option<String>,
    /// Gids of downloads aria2 generated from this one. A `bt-metadata-only`
    /// pass has exactly one once its metadata resolves: the real download,
    /// spawned by `follow-torrent`, with the torrent's actual file list —
    /// which the metadata gid's own `files` (one entry: itself) is not.
    pub followed_by: Vec<String>,
}

impl Download {
    /// The torrent's name, the first file's, or the gid — in that order. A
    /// magnet that has not resolved has none of the first two.
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

    /// `None` until the magnet resolves, which a `<progress>` with no value
    /// renders as indeterminate. That is the honest rendering: with
    /// `total_length` at zero a percentage is a division by zero, and
    /// "resolving the magnet" is a different state from "downloading nothing".
    pub fn percent(&self) -> Option<f64> {
        if self.total_length == 0 {
            return None;
        }
        Some(self.completed_length as f64 / self.total_length as f64 * 100.0)
    }

    pub fn health(&self) -> Health {
        // Status first: paused and errored are decisions made about the
        // download, not observations of its traffic, so they outrank
        // whatever the speed and seeder counts happen to say. Completion
        // comes next because a finished torrent still shows connections and
        // zero speed while idling. Only after all of that does the question
        // become "why is nothing moving", which is what the rest of the
        // branches diagnose in order from most to least fixable locally.
        if self.status == Status::Error {
            Health::Errored
        } else if self.status == Status::Paused {
            Health::Paused
        } else if self.is_finished() {
            Health::Complete
        } else if self.total_length == 0 {
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

    /// Complete for the purpose of watching it. A finished torrent seeds
    /// indefinitely and so never leaves aria2's active list, and a list where
    /// nothing ever finishes is a list nobody can read.
    pub fn is_finished(&self) -> bool {
        self.status == Status::Complete
            || (self.total_length > 0 && self.completed_length >= self.total_length)
    }
}

/// aria2's wire shape for one download: every count and size arrives as a
/// string, and `bittorrent`/`numSeeders` are present only when they apply.
/// This is the only place that shape exists — [`Download`] is what the rest
/// of the program reads.
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
    #[serde(default)]
    dir: String,
    #[serde(default)]
    files: Vec<RawFile>,
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
    /// Every numeric field defaults to 0 rather than
    /// failing, because a blank or transient counter is not worth losing the
    /// row over. Only a status aria2 has never documented — a sign the wire
    /// shape itself has drifted — is worth failing the whole download on.
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
            download_speed: self.download_speed.parse().unwrap_or(0),
            upload_speed: self.upload_speed.parse().unwrap_or(0),
            connections: self.connections.parse().unwrap_or(0),
            num_seeders: self.num_seeders.and_then(|s| s.parse().ok()).unwrap_or(0),
            error_message: self.error_message,
            dir: self.dir,
            files: self.files.into_iter().map(File::from).collect(),
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

    /// Stop it, forcibly if it will not stop cleanly — the reason to press the
    /// button is usually that something is misbehaving.
    pub async fn remove(&self, gid: &str) -> AppResult<()> {
        if self.call("remove", serde_json::json!([gid])).await.is_err() {
            self.call("forceRemove", serde_json::json!([gid])).await?;
        }
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn download(status: Status) -> Download {
        Download {
            gid: "gid1".to_string(),
            status,
            total_length: 0,
            completed_length: 0,
            download_speed: 0,
            upload_speed: 0,
            connections: 0,
            num_seeders: 0,
            error_message: None,
            dir: "/downloads".to_string(),
            files: Vec::new(),
            bittorrent_name: None,
            followed_by: Vec::new(),
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

    #[test]
    fn health_resolving() {
        let d = download(Status::Active);
        assert_eq!(d.health(), Health::Resolving);
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

    #[test]
    fn name_falls_back_to_the_first_files_basename_then_the_gid() {
        let mut d = download(Status::Active);
        assert_eq!(d.name(), "gid1");

        d.files.push(File {
            index: 1,
            path: "/downloads/Show/S01E01.mkv".to_string(),
            length: 0,
            selected: true,
        });
        assert_eq!(d.name(), "S01E01.mkv");

        d.bittorrent_name = Some("Show S01".to_string());
        assert_eq!(d.name(), "Show S01");
    }
}
