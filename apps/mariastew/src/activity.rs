//! A short account, per download, of what happened to it.
//!
//! aria2 holds the queue and this service holds nothing — except that the
//! interesting part of adding a magnet happens *here*, detached from the
//! request that started it (`routes::finish_add`), and aria2 has never heard
//! of any of it. Resolving, choosing which files to keep, applying the
//! selection, and giving up were visible only in the pod's log, so a row
//! sitting on "starting" looked identical whether it was waiting on a sparse
//! swarm or had failed twenty minutes ago. This is the record that tells
//! those apart, and it is the only state on this side of aria2.
//!
//! Bounded, and lost on restart, deliberately. It explains how a download got
//! where it is; *where it is* still comes from aria2, so a restarted pod
//! re-reads reality exactly as before and loses only the narrative.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

/// Lines kept per download — the whole add sequence plus room for the state
/// changes of a long one. Older lines fall off the front.
const MAX_ENTRIES: usize = 60;

/// Downloads tracked at once, oldest evicted. A cap rather than pruning
/// against aria2's list: the gid a log is filed under routinely leaves that
/// list while the log is still wanted (see [`Activity::link`]), so "is it
/// still there" is the wrong question to evict on.
const MAX_LOGS: usize = 200;

#[derive(Clone)]
pub struct Entry {
    /// Wall clock, not `Instant`. A log is read as "what happened, and when",
    /// and an elapsed count answers a different question — every line saying
    /// "2m" tells you nothing about the order or the gaps, which are the two
    /// things a log is for. See `views::LogView` for what renders it.
    pub at: SystemTime,
    pub message: String,
}

#[derive(Clone, Default)]
pub struct Activity {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    logs: HashMap<String, VecDeque<Entry>>,
    /// A download's gid is not the gid its own history was written under: a
    /// magnet resolves under one gid and `follow-torrent` spawns the real
    /// download under another. This points the second at the first.
    aliases: HashMap<String, String>,
    /// Insertion order of `logs`, for evicting the oldest.
    order: VecDeque<String>,
}

impl Inner {
    fn canonical<'a>(&'a self, gid: &'a str) -> &'a str {
        self.aliases.get(gid).map(String::as_str).unwrap_or(gid)
    }
}

impl Activity {
    pub fn new() -> Self {
        Self::default()
    }

    /// A poisoned lock is recovered from rather than propagated: this holds an
    /// explanation of a download, and losing every explanation because one
    /// render panicked mid-push is a worse outcome than a possibly-torn line.
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn record(&self, gid: &str, message: impl Into<String>) {
        let message = message.into();
        let mut inner = self.lock();
        let key = inner.canonical(gid).to_string();

        if !inner.logs.contains_key(&key) {
            if inner.order.len() >= MAX_LOGS
                && let Some(oldest) = inner.order.pop_front()
            {
                inner.logs.remove(&oldest);
                inner.aliases.retain(|_, target| *target != oldest);
            }
            inner.order.push_back(key.clone());
        }

        let log = inner.logs.entry(key).or_default();
        if log.len() >= MAX_ENTRIES {
            log.pop_front();
        }
        log.push_back(Entry {
            at: SystemTime::now(),
            message,
        });
    }

    /// Point `to` at `from`'s log, so that what was recorded while a magnet
    /// resolved belongs to the download that came out of it. Without this the
    /// account of an add would be filed under the metadata gid, which
    /// disappears from every list the moment the real download exists — the
    /// row that survives is the one that needs the history.
    pub fn link(&self, from: &str, to: &str) {
        let mut inner = self.lock();
        let key = inner.canonical(from).to_string();
        inner.aliases.insert(to.to_string(), key);
    }

    pub fn entries(&self, gid: &str) -> Vec<Entry> {
        let inner = self.lock();
        inner
            .logs
            .get(inner.canonical(gid))
            .map(|log| log.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Drop a download's history along with the download. Only the explicit
    /// remove calls this — everything else relies on the cap above.
    pub fn forget(&self, gid: &str) {
        let mut inner = self.lock();
        let key = inner.canonical(gid).to_string();
        inner.logs.remove(&key);
        inner.order.retain(|g| *g != key);
        inner
            .aliases
            .retain(|from, target| *target != key && *from != key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn messages(activity: &Activity, gid: &str) -> Vec<String> {
        activity
            .entries(gid)
            .into_iter()
            .map(|e| e.message)
            .collect()
    }

    #[test]
    fn entries_come_back_in_the_order_they_were_recorded() {
        let activity = Activity::new();
        activity.record("a", "first");
        activity.record("a", "second");
        assert_eq!(messages(&activity, "a"), ["first", "second"]);
    }

    #[test]
    fn an_unknown_gid_has_an_empty_log_rather_than_no_log() {
        assert!(Activity::new().entries("nope").is_empty());
    }

    /// The whole reason [`Activity::link`] exists: everything worth reading
    /// about an add — the destination, the resolve, what the filter threw
    /// away — is recorded before the gid that ends up on screen exists.
    #[test]
    fn a_linked_gid_reads_and_appends_to_the_log_of_the_gid_it_came_from() {
        let activity = Activity::new();
        activity.record("metadata", "waiting for the magnet to resolve");
        activity.link("metadata", "child");

        assert_eq!(
            messages(&activity, "child"),
            ["waiting for the magnet to resolve"],
            "the child must inherit what was recorded before it existed"
        );

        activity.record("child", "keeping 1 of 3 files");
        assert_eq!(
            messages(&activity, "metadata"),
            messages(&activity, "child"),
            "both gids name one log, so a later write is visible through either"
        );
    }

    #[test]
    fn a_log_keeps_the_newest_entries_and_drops_the_oldest() {
        let activity = Activity::new();
        for i in 0..MAX_ENTRIES + 5 {
            activity.record("a", format!("line {i}"));
        }
        let messages = messages(&activity, "a");
        assert_eq!(messages.len(), MAX_ENTRIES);
        assert_eq!(messages.first().unwrap(), "line 5");
        assert_eq!(
            messages.last().unwrap(),
            &format!("line {}", MAX_ENTRIES + 4)
        );
    }

    /// Nothing prunes this against aria2's list, so the cap is the only thing
    /// standing between a long-lived pod and unbounded growth.
    #[test]
    fn the_oldest_download_is_evicted_once_too_many_are_tracked() {
        let activity = Activity::new();
        for i in 0..MAX_LOGS + 1 {
            activity.record(&format!("gid{i}"), "added");
        }
        assert!(
            activity.entries("gid0").is_empty(),
            "the first download tracked should have been evicted"
        );
        assert!(!activity.entries("gid1").is_empty());
        assert!(!activity.entries(&format!("gid{MAX_LOGS}")).is_empty());
    }

    #[test]
    fn forgetting_a_download_forgets_it_under_every_gid_that_named_it() {
        let activity = Activity::new();
        activity.record("metadata", "added");
        activity.link("metadata", "child");
        activity.forget("child");
        assert!(activity.entries("child").is_empty());
        assert!(activity.entries("metadata").is_empty());
    }
}
