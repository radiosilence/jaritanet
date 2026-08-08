//! What the templates are handed.
//!
//! aria2's shapes do not reach a template. Everything a row needs is computed
//! once here — the numbers formatted, the health resolved — so the markup makes
//! no decisions and there is one place to test the ones that matter.

use askama::Template;

use crate::activity::Entry;
use crate::aria2::{self, Download, Health, Status};

/// A destination the picker offers, which is also a mount the pod has.
pub struct RootView {
    pub name: String,
    pub path: String,
}

/// A directory under a root, for the picker.
pub struct DirView {
    pub name: String,
    pub path: String,
}

/// One file inside a torrent, as the expanded row lists it. A deselected file
/// is listed rather than hidden: "why is that one not downloading" is the
/// question a missing row cannot answer, and the garbage filter's decisions
/// were previously visible only in the pod's log.
pub struct FileView {
    pub name: String,
    pub size: String,
    pub percent_display: Option<String>,
    pub selected: bool,
}

/// A line of a download's history, at the time it happened.
///
/// Both forms of the timestamp, because the pod has no timezone and the
/// browser does. `utc` is what the markup carries and what a page with no
/// working JavaScript keeps; `at_ms` feeds a `data-text` expression that
/// rewrites it in the reader's own local time. Only an integer is ever
/// interpolated into that expression — the escaping lesson from the
/// destination picker is that HTML escaping is no defence inside something
/// the browser goes on to evaluate, so nothing evaluated may carry a string.
pub struct LogView {
    pub utc: String,
    pub at_ms: u64,
    pub message: String,
}

/// Files listed before the rest are folded into a count. A season pack is
/// twenty entries and reads fine; a discography is five hundred and would be
/// the largest thing on the page, re-sent at the poll rate to say nothing.
const MAX_FILES_SHOWN: usize = 24;

pub struct Row {
    pub gid: String,
    pub name: String,
    /// `None` while the magnet is still resolving, which renders as an
    /// indeterminate bar rather than as zero.
    pub percent: Option<f64>,
    /// Rounded to a whole number for the `<progress>` `value` — the template
    /// never prints the raw `f64` `percent` directly.
    pub percent_display: Option<String>,
    /// Kept for callers that need the raw reading; the row itself only shows
    /// its two derived readings, `bar_class` and `state`.
    #[allow(dead_code)]
    pub health: Health,
    /// DaisyUI modifier for the bar — the fast way to read a row at arm's
    /// length. The icons carry the same meaning for a washed-out screen.
    pub bar_class: &'static str,
    pub state: &'static str,
    /// Absent when nothing is moving — a rate of `0 B/s` reads as a
    /// measurement, and an idle row has not measured anything. The collapsed
    /// row shows `down` beside the destination and shows neither when it is
    /// absent, so this has to be the absence rather than a dash.
    pub down: Option<String>,
    pub up: Option<String>,
    pub size: String,
    pub done: String,
    /// Time left at the current rate, absent whenever that rate would make one
    /// up. See `Download::eta_secs` — it is `None` whenever `down` is, so the
    /// collapsed row can nest the two rather than combine them.
    pub eta: Option<String>,
    /// Given back to the swarm, and as a multiple of what was taken. The
    /// ratio is absent until something has actually been downloaded to divide
    /// by.
    pub uploaded: String,
    pub ratio: Option<String>,
    pub connections: u32,
    pub seeders: u32,
    /// How aria2 is cutting the torrent up, which is the explanation for both
    /// lumpy progress and for a deselected file landing anyway.
    pub pieces: Option<String>,
    pub info_hash: Option<String>,
    pub error: Option<String>,
    /// aria2's numeric reason, in words where there are words for it. Shown
    /// beside `error` and, more to the point, instead of it when aria2 left
    /// the message empty.
    pub error_code: Option<String>,
    /// Only shown alongside `error`, in the disclosure that reveals why a
    /// row failed — nobody needs the destination of a download that is
    /// working.
    pub dir: String,
    pub files: Vec<FileView>,
    pub file_count: usize,
    pub selected_count: usize,
    /// What the garbage filter left out, once there is anything to say about
    /// it: "2 skipped, 58.3 MiB".
    pub skipped: Option<String>,
    pub log: Vec<LogView>,
    pub finished: bool,
    pub paused: bool,
    /// Removal asked for and not yet confirmed — see `state::Clearing`. It
    /// replaces `state` above rather than sitting beside it: a row on its way
    /// out is not "ready", whatever aria2 still says about the swarm.
    pub clearing: bool,
}

/// DaisyUI modifier and the word for it, together — colour alone is never
/// the only way to read a row (see `Row::bar_class`).
///
/// The words are the ones a person would use about a download, not the ones
/// the enum uses about a swarm. `Health::Moving` naming itself "moving" on
/// screen was the giveaway: it is precise about traffic and meaningless to
/// whoever is waiting for a film. Each state now says either what is
/// happening or what is wrong, in the terms of the thing being waited for.
///
/// "starting" used to answer for everything between pasting a magnet and the
/// first byte, which is where a download spends the time someone actually
/// spends wondering about it: an unresolved magnet, one queued behind
/// `maxConcurrentDownloads`, and a resumed one being hash-checked all said it.
/// The last two are not even the same *kind* of waiting, and both were being
/// diagnosed as a dead swarm further down this match, so each now says which
/// it is. What is deliberately *not* split is the resolving magnet itself —
/// see the note on `Health::Resolving` for the reading that turned out to
/// mean nothing.
fn bar_class_and_state(health: Health) -> (&'static str, &'static str) {
    match health {
        Health::Moving => ("progress-success", "downloading"),
        Health::Complete => ("progress-success", "ready"),
        Health::Choked => ("progress-warning", "stalled"),
        Health::Blocked => ("progress-error", "can't connect"),
        Health::Errored => ("progress-error", "failed"),
        Health::Dead => ("progress-error", "no seeders"),
        Health::Queued => ("progress-info", "queued"),
        Health::Resolving => ("progress-info", "finding peers"),
        Health::Verifying => ("progress-info", "checking files"),
        Health::Paused => ("progress-info", "paused"),
    }
}

/// The word a row shows for a state, for anything that needs to name one
/// outside a row — the activity log, which records a state change in the same
/// words the badge is about to show, rather than a second vocabulary for the
/// same set of facts.
pub fn state_word(health: Health) -> &'static str {
    bar_class_and_state(health).1
}

/// The last path segment, which is the only part of a file worth a row of its
/// own — every file in a torrent shares the rest of it with its siblings.
fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

impl Row {
    pub fn new(d: &Download, log: Vec<Entry>, clearing: bool) -> Self {
        let percent = d.percent();
        let health = d.health();
        // Not a `Health`: nothing has been asked of the swarm and aria2's
        // reading has not changed, so this is a fact about a request in flight
        // rather than about the download. It still outranks the reading —
        // "ready" beside a spinner is the confusion the mark exists to remove.
        let (bar_class, state) = if clearing {
            ("progress-info", "clearing")
        } else {
            bar_class_and_state(health)
        };
        let (size, done) = d.display_totals();

        let (skipped_count, skipped_bytes) = d
            .files
            .iter()
            .filter(|f| !f.selected)
            .fold((0usize, 0u64), |(n, b), f| (n + 1, b + f.length));

        Row {
            gid: d.gid.clone(),
            // A still-resolving magnet is named `[METADATA]<infohash>` by
            // aria2. The marker is how the row is classified, not something
            // to read — the state badge already says what it is doing.
            name: d.name().trim_start_matches("[METADATA]").to_string(),
            percent,
            percent_display: percent.map(|p| format!("{p:.0}")),
            health,
            bar_class,
            state,
            down: rate(d.download_speed),
            up: rate(d.upload_speed),
            // The same totals the bar is drawn from — see `display_totals`.
            size: bytes(size),
            done: bytes(done),
            eta: d.eta_secs().map(duration),
            uploaded: bytes(d.upload_length),
            ratio: d.ratio().map(|r| format!("{r:.2}")),
            connections: d.connections,
            seeders: d.num_seeders,
            pieces: (d.num_pieces > 0)
                .then(|| format!("{} pieces × {}", d.num_pieces, bytes(d.piece_length))),
            info_hash: d.info_hash.clone(),
            error: d.error_message.clone().filter(|m| !m.is_empty()),
            error_code: d
                .error_code
                .map(|code| match aria2::error_code_meaning(code) {
                    Some(meaning) => format!("aria2 code {code} — {meaning}"),
                    None => format!("aria2 code {code}"),
                }),
            dir: d.dir.clone(),
            files: d
                .files
                .iter()
                .take(MAX_FILES_SHOWN)
                .map(|f| FileView {
                    name: basename(&f.path).to_string(),
                    size: bytes(f.length),
                    // A deselected file's own bar would only ever report
                    // piece-boundary spillover, which is not progress towards
                    // anything — the row says "skipped" instead.
                    percent_display: (f.selected && f.length > 0).then(|| {
                        format!("{:.0}", f.completed_length as f64 / f.length as f64 * 100.0)
                    }),
                    selected: f.selected,
                })
                .collect(),
            file_count: d.files.len(),
            selected_count: d.files.len() - skipped_count,
            skipped: (skipped_count > 0)
                .then(|| format!("{skipped_count} skipped, {}", bytes(skipped_bytes))),
            log: log
                .into_iter()
                .map(|e| {
                    let ms =
                        e.at.duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;
                    LogView {
                        utc: utc_hms(ms),
                        at_ms: ms,
                        message: e.message,
                    }
                })
                .collect(),
            finished: d.is_finished(),
            paused: d.status == Status::Paused,
            clearing,
        }
    }
}

#[derive(Template)]
#[template(path = "page.html")]
pub struct Page {
    pub roots: Vec<RootView>,
    pub rows: Vec<Row>,
    /// Set when the aria2 poll behind this render failed. The page still
    /// renders — with an empty `rows` and, inside `#downloads`, a warning in
    /// place of the list — rather than a blank 500, because a restarted
    /// sidecar should not take the UI down with it.
    pub aria2_unreachable: bool,
}

impl Page {
    /// The picker's starting view — the configured roots, rendered as though
    /// browsing had not gone anywhere yet. `{% include %}` cannot do this: it
    /// shares this template's own fields, and `Browse`'s (`parent`, `path`,
    /// `dirs`) are a different shape, so the page renders the fragment through
    /// `Browse` directly and splices in the string.
    fn picker(&self) -> askama::Result<String> {
        Browse {
            parent: None,
            path: String::new(),
            label: String::new(),
            dirs: self
                .roots
                .iter()
                .map(|r| DirView {
                    name: r.name.clone(),
                    path: r.path.clone(),
                })
                .collect(),
        }
        .render()
    }
}

/// The list on its own. Its root element carries the same id as the one in the
/// page, which is how Datastar morphs it in place — and why it is only sent
/// when a download appears or disappears, since morphing by id can do neither.
#[derive(Template)]
#[template(path = "downloads.html")]
pub struct Downloads {
    pub rows: Vec<Row>,
    /// Always false from the poller: a snapshot only exists once aria2 has
    /// answered, so a container coming down the stream is by construction the
    /// list of a reachable service — which is what retires the warning the
    /// page may have rendered with.
    pub aria2_unreachable: bool,
}

/// One row, which is what the stream sends for every change that is not a
/// download arriving or leaving. Same markup, same id, rendered from the same
/// file the list renders each of its rows from.
#[derive(Template)]
#[template(path = "row.html")]
pub struct RowMarkup<'a> {
    pub row: &'a Row,
}

#[derive(Template)]
#[template(path = "browse.html")]
pub struct Browse {
    /// Absent at a root, which is where browsing upward stops.
    pub parent: Option<String>,
    /// The absolute path, which is what the hidden inputs submit and what
    /// aria2 is eventually handed — never what is shown.
    pub path: String,
    /// The same place said the way the picker says it (`Config::label`), which
    /// is the only form that reaches the screen. Empty at the root list, where
    /// no destination has been picked yet.
    pub label: String,
    pub dirs: Vec<DirView>,
}

const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];

/// Bytes at three significant figures. Nobody reads the fourth on a phone.
pub fn bytes(n: u64) -> String {
    if n < 1024 {
        return format!("{n} B");
    }
    let mut value = n as f64 / 1024.0;
    let mut unit = 1;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    let digits = if value >= 100.0 {
        0
    } else if value >= 10.0 {
        1
    } else {
        2
    };
    format!("{value:.digits$} {}", UNITS[unit])
}

/// A transfer rate, or nothing when nothing is moving — a rate of `0 B/s`
/// reads as a measurement, and an idle row has not measured anything. Whether
/// that absence is drawn as a dash or as nothing at all is the caller's
/// decision: the expanded panel is a table of readings and wants the dash, the
/// collapsed row wants the space back.
pub fn rate(n: u64) -> Option<String> {
    (n > 0).then(|| format!("{}/s", bytes(n)))
}

/// A span of time in the two largest units it needs. Nobody waiting on a film
/// wants the seconds off a four-hour estimate, and nobody waiting on the last
/// thirty seconds wants them rounded away.
pub fn duration(secs: u64) -> String {
    if secs >= 3600 {
        format!("{}h {}m", secs / 3600, secs % 3600 / 60)
    } else if secs >= 60 {
        format!("{}m {}s", secs / 60, secs % 60)
    } else {
        format!("{secs}s")
    }
}

/// `hh:mm:ss` UTC from epoch milliseconds, which needs no date crate and no
/// timezone the pod does not have. This is the static content of a log line's
/// timestamp; the browser rewrites it in local time (see [`LogView`]), so it
/// is what remains when that does not happen rather than what is normally
/// read. No date, deliberately — the log is bounded and every line in it is
/// from the life of a download currently on screen.
pub fn utc_hms(epoch_ms: u64) -> String {
    let secs = epoch_ms / 1000 % 86_400;
    format!(
        "{:02}:{:02}:{:02}",
        secs / 3600,
        secs % 3600 / 60,
        secs % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::aria2::File;

    /// A torrent halfway through, which is what most of these render and vary
    /// one field of. Built through `Row::new` rather than as a `Row` literal
    /// so a test cannot pin a combination the conversion would never produce
    /// — a literal was free to claim `Health::Moving` beside a state of
    /// "failed", and several did.
    fn moving() -> Download {
        Download {
            gid: "abc".to_string(),
            total_length: 1_073_741_824,
            completed_length: 536_870_912,
            download_speed: 1_048_576,
            connections: 1,
            num_seeders: 1,
            bittorrent_name: Some("Show.S01E01".to_string()),
            ..Download::fixture()
        }
    }

    fn render(d: &Download) -> String {
        render_with_log(d, Vec::new())
    }

    fn render_with_log(d: &Download, log: Vec<Entry>) -> String {
        render_row(d, log, false)
    }

    fn render_row(d: &Download, log: Vec<Entry>, clearing: bool) -> String {
        (Downloads {
            rows: vec![Row::new(d, log, clearing)],
            aria2_unreachable: false,
        })
        .render()
        .expect("downloads template renders")
    }

    fn file(index: u32, path: &str, length: u64, completed_length: u64, selected: bool) -> File {
        File {
            index,
            path: path.to_string(),
            length,
            completed_length,
            selected,
        }
    }

    /// The breakout the picker has to keep stopping: a directory the owner
    /// can create, named so that it closes whatever it is pasted into.
    ///
    /// It used to be pasted into a per-row Datastar expression, where HTML
    /// escaping was no defence — the browser turns `&#x27;` back into a quote
    /// before the expression is parsed — so the name was percent-encoded into
    /// a URL instead. With one delegated handler the name travels as an
    /// ordinary attribute value that nothing evaluates, and Askama's escaping
    /// is the whole defence. This asserts the property rather than either
    /// mechanism: the hostile name must not appear raw, and no `data-on:`
    /// attribute may carry it.
    #[test]
    fn a_directory_name_cannot_break_out_of_the_picker_markup() {
        let html = Browse {
            parent: Some("/mnt/kontent".into()),
            path: "/mnt/kontent/tv".into(),
            label: "tv".into(),
            dirs: vec![DirView {
                name: "'+alert(1)+'".into(),
                path: "/mnt/kontent/tv/'+alert(1)+'".into(),
            }],
        }
        .render()
        .expect("browse template renders");

        assert!(
            !html.contains("'+alert(1)+'"),
            "the raw name reached the document: {html}"
        );
        assert!(
            html.contains("&#x27;+alert(1)+&#x27;") || html.contains("&#39;+alert(1)+&#39;"),
            "the name should still render, with its quotes escaped: {html}"
        );
        for line in html.lines().filter(|l| l.contains("data-on:")) {
            assert!(
                !line.contains("alert(1)"),
                "a name reached an evaluated attribute: {line}"
            );
        }
    }

    #[test]
    fn bytes_at_zero() {
        assert_eq!(bytes(0), "0 B");
    }

    #[test]
    fn bytes_just_under_a_kib() {
        assert_eq!(bytes(1023), "1023 B");
    }

    #[test]
    fn bytes_at_a_kib() {
        assert_eq!(bytes(1024), "1.00 KiB");
    }

    #[test]
    fn bytes_in_the_tib_range() {
        assert_eq!(bytes(3 * 1024u64.pow(4)), "3.00 TiB");
    }

    #[test]
    fn rate_at_zero_is_nothing_at_all() {
        assert_eq!(rate(0), None);
    }

    #[test]
    fn rate_is_bytes_per_second() {
        assert_eq!(rate(1024).as_deref(), Some("1.00 KiB/s"));
    }

    #[test]
    fn state_moving() {
        assert_eq!(
            bar_class_and_state(Health::Moving),
            ("progress-success", "downloading")
        );
    }

    #[test]
    fn state_complete() {
        assert_eq!(
            bar_class_and_state(Health::Complete),
            ("progress-success", "ready")
        );
    }

    #[test]
    fn state_choked() {
        assert_eq!(
            bar_class_and_state(Health::Choked),
            ("progress-warning", "stalled")
        );
    }

    #[test]
    fn state_blocked() {
        assert_eq!(
            bar_class_and_state(Health::Blocked),
            ("progress-error", "can't connect")
        );
    }

    #[test]
    fn state_errored() {
        assert_eq!(
            bar_class_and_state(Health::Errored),
            ("progress-error", "failed")
        );
    }

    #[test]
    fn state_dead() {
        assert_eq!(
            bar_class_and_state(Health::Dead),
            ("progress-error", "no seeders")
        );
    }

    /// "starting" used to answer for all three of these. Each has a different
    /// answer to "should I wait or fix this", which is the whole reason the
    /// state is a word rather than just a colour.
    #[test]
    fn the_states_that_replaced_starting_each_say_which_one_they_are() {
        assert_eq!(
            bar_class_and_state(Health::Resolving),
            ("progress-info", "finding peers")
        );
        assert_eq!(
            bar_class_and_state(Health::Queued),
            ("progress-info", "queued")
        );
        assert_eq!(
            bar_class_and_state(Health::Verifying),
            ("progress-info", "checking files")
        );
    }

    /// The log records a transition in the same words the badge is about to
    /// show it in — one vocabulary for one set of facts.
    #[test]
    fn the_word_the_log_uses_for_a_state_is_the_word_the_badge_uses() {
        assert_eq!(state_word(Health::Resolving), "finding peers");
        assert_eq!(state_word(Health::Moving), "downloading");
    }

    #[test]
    fn state_paused() {
        assert_eq!(
            bar_class_and_state(Health::Paused),
            ("progress-info", "paused")
        );
    }

    /// Datastar v1.0.2's generic `on` plugin splits the attribute suffix on
    /// `:` to get the event name (`data-on:click`) — a dash (`data-on-click`)
    /// resolves to a plugin named `on-click`, which does not exist, and the
    /// attribute is dropped without an error. Every click handler on the page
    /// silently did nothing until this was `:`. This test pins the syntax so
    /// it cannot regress one attribute at a time.
    #[test]
    fn add_download_button_uses_colon_syntax_datastar_actually_matches() {
        let page = Page {
            roots: vec![],
            rows: vec![],
            aria2_unreachable: false,
        }
        .render()
        .unwrap();
        assert!(
            page.contains("$addDialog.showModal()") && page.contains(r#"data-on:click=""#),
            "add-dialog button markup: {page}"
        );
        // The generic "on" plugin needs the colon (data-on:click) — see the
        // doc comment above. Named plugins with no key of their own, like
        // on-interval, are matched by their literal dash-joined name and are
        // correctly `data-on-interval`; excluded here rather than making the
        // check `!contains("data-on-")`, which they would otherwise fail.
        assert!(
            !page.contains("data-on-click") && !page.contains("data-on-submit"),
            "a dash-form data-on- attribute survived and will be silently ignored: {page}"
        );
    }

    #[test]
    fn add_dialog_opens_as_a_native_modal_over_the_open_state() {
        let page = Page {
            roots: vec![],
            rows: vec![],
            aria2_unreachable: false,
        }
        .render()
        .unwrap();
        assert!(
            page.contains(r#"id="add-dialog""#) && page.contains("open:flex"),
            "dialog is not styled to appear once the browser sets [open]: {page}"
        );
    }

    /// An empty queue and a page that failed to render its list looked
    /// identical — nothing at all under the Add button. The container has to
    /// say which it is, and say what to do about it.
    #[test]
    fn an_empty_list_says_so_rather_than_rendering_nothing() {
        let empty = Downloads {
            rows: vec![],
            aria2_unreachable: false,
        }
        .render()
        .unwrap();
        assert!(
            empty.contains("Nothing downloading") && empty.contains(r#"data-icon="inbox""#),
            "no empty state in the list container: {empty}"
        );

        let occupied = Downloads {
            rows: vec![Row::new(&moving(), Vec::new(), false)],
            aria2_unreachable: false,
        }
        .render()
        .unwrap();
        assert!(
            !occupied.contains("Nothing downloading") && occupied.contains(r#"id="dl-abc""#),
            "the empty state showed alongside a download: {occupied}"
        );
    }

    /// The two empty lists are not the same empty list. "Paste a magnet link"
    /// is advice that cannot work while the service that would accept it is
    /// unreachable, so the warning replaces the invitation rather than sitting
    /// above it.
    #[test]
    fn an_unreachable_service_is_not_an_empty_queue() {
        let down = Downloads {
            rows: vec![],
            aria2_unreachable: true,
        }
        .render()
        .unwrap();
        assert!(down.contains("unreachable"), "no warning: {down}");
        assert!(
            !down.contains("Nothing downloading"),
            "an outage was reported as an empty queue: {down}"
        );
    }

    #[test]
    fn aria2_unreachable_shows_a_banner_and_no_downloads_section_is_silently_wrong() {
        let with_banner = Page {
            roots: vec![],
            rows: vec![],
            aria2_unreachable: true,
        }
        .render()
        .unwrap();
        assert!(
            with_banner.contains("alert-warning"),
            "no banner when aria2 is unreachable: {with_banner}"
        );

        let without_banner = Page {
            roots: vec![],
            rows: vec![],
            aria2_unreachable: false,
        }
        .render()
        .unwrap();
        assert!(
            !without_banner.contains("alert-warning"),
            "banner shown when aria2 is fine: {without_banner}"
        );
    }

    #[test]
    fn browse_and_download_row_actions_all_use_colon_syntax() {
        let page = render(&moving());
        assert!(page.contains(r#"data-on:click="@post('/downloads/abc/pause')""#));
        assert!(!page.contains("data-on-"));

        let browse = Browse {
            parent: Some("/mnt/tv".into()),
            path: "/mnt/tv/show".into(),
            label: "tv/show".into(),
            dirs: vec![DirView {
                name: "season 1".into(),
                path: "/mnt/tv/show/season 1".into(),
            }],
        }
        .render()
        .unwrap();
        assert!(browse.contains("data-on:click"));
        assert!(!browse.contains("data-on-"));
    }

    /// Icons are inline Lucide `<svg>`, never a character. A glyph is
    /// whatever the device decides it is: 🌱 and 🔗 come from the emoji font
    /// at its own weight, colour and baseline rather than the text's, and
    /// `⌂` is absent from enough fonts to arrive as a tofu box — a button
    /// with nothing legible in it.
    ///
    /// The assertion is the property, not the icon set: no pictographic
    /// character may reach the markup, whichever one someone reaches for
    /// next. Dashes and ellipses are punctuation and stay out of the ranges
    /// below — `rate()` returns an em dash for an idle row.
    #[test]
    fn nothing_is_drawn_with_a_unicode_glyph() {
        let glyph = |html: &str| {
            html.chars().find(|c| {
                matches!(c,
                    '\u{2190}'..='\u{21FF}'      // arrows
                    | '\u{2300}'..='\u{27BF}'    // technical, dingbats
                    | '\u{2B00}'..='\u{2BFF}'    // more arrows
                    | '\u{1F300}'..='\u{1FAFF}'  // emoji
                )
            })
        };

        // Finished, so the one row rendered here is also the only one that
        // carries the tick.
        // Named rather than counted: every call site added later changes a
        // count, and none of them says whether the tick is still on the
        // finished badge.
        let downloads = render(&Download {
            completed_length: 1_073_741_824,
            ..moving()
        });
        for icon in ["check", "folder", "pause"] {
            assert!(
                downloads.contains(&format!("data-icon=\"{icon}\"")),
                "the finished row lost its {icon}: {downloads}"
            );
        }
        assert_eq!(glyph(&downloads), None, "{downloads}");

        let browse = Browse {
            parent: Some("/mnt/kontent".into()),
            path: "/mnt/kontent/tv".into(),
            label: "tv".into(),
            dirs: vec![],
        }
        .render()
        .unwrap();
        // Home and Up, the two reachable only below a root, plus the
        // create-folder button that has nothing but its icon.
        for icon in ["house", "arrow-up", "folder-plus"] {
            assert!(
                browse.contains(&format!("data-icon=\"{icon}\"")),
                "the picker lost its {icon}: {browse}"
            );
        }
        assert_eq!(glyph(&browse), None, "{browse}");

        // The whole page, which is also the only place the add button and
        // its icon-only label appear. Rendered unreachable so the warning
        // banner — the other icon that only exists here — is in it too.
        let page = Page {
            roots: vec![],
            rows: vec![],
            aria2_unreachable: true,
        }
        .render()
        .unwrap();
        for icon in ["plus", "triangle-alert", "circle-check"] {
            assert!(
                page.contains(&format!("data-icon=\"{icon}\"")),
                "the page lost its {icon}: {page}"
            );
        }
        assert_eq!(glyph(&page), None, "{page}");
    }

    /// A real release name — title and year first, encoding detail last —
    /// with no ellipsis to hide any of it: `line-clamp-2` wraps rather than
    /// truncates, because two folders in the same list can differ only in
    /// that tail (a part number, a disc, a cut), which an end-ellipsis would
    /// hide on exactly the two entries a picker most needs to tell apart.
    #[test]
    fn long_directory_names_wrap_instead_of_being_cut_off() {
        let long_name = "Static.Tide.1994.Criterion.1080p.BluRay.x265.HEVC.10bit.AAC.5.1";
        let browse = Browse {
            parent: None,
            path: String::new(),
            label: String::new(),
            dirs: vec![DirView {
                name: long_name.into(),
                path: format!("/mnt/kontent/movies/{long_name}"),
            }],
        }
        .render()
        .unwrap();
        assert!(
            browse.contains(long_name),
            "the full name must still be in the markup — wrapped, not cut: {browse}"
        );
        assert!(
            browse.contains("break-words"),
            "the directory row is not set to wrap: {browse}"
        );
        // A fixed line-clamp was tried and rejected (see the comment in
        // browse.html): a name long enough to need a third line clips it
        // right where a PART1/PART2-style suffix usually lives, which
        // defeats the one thing this row exists to guarantee. There is no
        // safe fixed number of lines, so there is no clamp at all.
        assert!(
            !browse.contains("line-clamp"),
            "a line-clamp on the directory row can hide the tail of a long enough name: {browse}"
        );
    }

    /// The regression this whole design exists to prevent: two names alike
    /// except for a tail long enough to fall on a would-be third line. Both
    /// full names must be in the markup, not just their common prefix.
    #[test]
    fn two_directory_names_differing_only_near_the_end_are_both_fully_present() {
        let common =
            "Harbourlight.2004.Criterion.Collection.2160p.UHD.BluRay.REMUX.HEVC.HDR.DTS-HD.MA.5.1";
        let part1 = format!("{common}.PART1");
        let part2 = format!("{common}.PART2");
        let browse = Browse {
            parent: None,
            path: String::new(),
            label: String::new(),
            dirs: vec![
                DirView {
                    name: part1.clone(),
                    path: format!("/mnt/kontent/movies/{part1}"),
                },
                DirView {
                    name: part2.clone(),
                    path: format!("/mnt/kontent/movies/{part2}"),
                },
            ],
        }
        .render()
        .unwrap();
        assert!(
            browse.contains(&part1) && browse.contains(&part2),
            "both full names, PART1 and PART2 tail included, must be in the markup: {browse}"
        );
    }

    /// The current path is the answer to "where will this land" (#257) — an
    /// end-ellipsis on a full path tends to hide the last segment, which is
    /// the one part of it that answers that question. It wraps for the same
    /// reason the directory rows do, and `min-w-0` is load-bearing: without
    /// it a flex item will not shrink to wrap at all, it will just overflow
    /// its row instead.
    ///
    /// It is the label that is shown, not the path (#303): the mount point
    /// above the root is the same on every destination, so it distinguishes
    /// nothing while costing the line the width the tail needs. The absolute
    /// path is still in the markup — the hidden inputs submit it — so this
    /// asserts it is not what gets *rendered*.
    #[test]
    fn the_current_path_is_shown_from_the_picked_root_and_wraps() {
        let tail = "Static.Tide.1994.Criterion.1080p.BluRay.x265.HEVC.10bit.AAC.5.1";
        let browse = Browse {
            parent: Some("/mnt/kontent/movies".into()),
            path: format!("/mnt/kontent/movies/{tail}"),
            label: format!("movies/{tail}"),
            dirs: vec![],
        }
        .render()
        .unwrap();
        assert!(
            browse.contains(&format!(">movies/{tail}</span>")),
            "the label, whole tail included, is not the line's text: {browse}"
        );
        assert!(
            !browse.contains(&format!(">/mnt/kontent/movies/{tail}")),
            "the mount point is back on the visible line: {browse}"
        );
        assert!(
            browse.contains(&format!(r#"name="dir" value="/mnt/kontent/movies/{tail}""#)),
            "the absolute path must still be what is submitted: {browse}"
        );
        assert!(
            browse.contains("break-words") && browse.contains("min-w-0"),
            "the path cannot wrap or shrink inside its flex row: {browse}"
        );
    }

    /// The disclosure needs no JavaScript to work at all — a native
    /// `<details>`/`<summary>` — and must carry enough to actually diagnose
    /// the failure: the message, which download, and where it was headed.
    #[test]
    fn an_errored_row_discloses_the_message_gid_and_destination() {
        let page = render(&Download {
            gid: "abc123".to_string(),
            status: Status::Error,
            error_message: Some("No space left on device".to_string()),
            dir: "/mnt/kontent/tv/Show/S01".to_string(),
            ..moving()
        });
        assert!(page.contains("<details") && page.contains("<summary"));
        assert!(page.contains("No space left on device"));
        assert!(page.contains("abc123"));
        assert!(page.contains("/mnt/kontent/tv/Show/S01"));
        // The full destination path in the error box wraps rather than
        // truncates — this is the one place someone opened specifically to
        // read everything, so hiding the tail of the path would defeat the
        // reason the disclosure exists. `break-words` on the wrapper is
        // what makes an unbroken path (no spaces) wrap instead of overflow.
        assert!(page.contains("break-words"));
    }

    /// A collapsed row is deliberately different from the picker: it is
    /// scanned repeatedly rather than chosen once, so a single truncated
    /// line stays scannable and the full name is a tap away in the row's
    /// own disclosure — unlike the picker, there is no second entry in this
    /// list it needs to stay distinguishable from at a glance.
    #[test]
    fn a_long_torrent_name_still_truncates_to_one_line_in_the_collapsed_row() {
        let long_name = "Static.Tide.1994.Criterion.1080p.BluRay.x265.HEVC.10bit.AAC.5.1";
        let page = render(&Download {
            bittorrent_name: Some(long_name.to_string()),
            ..moving()
        });
        assert!(
            page.contains(long_name),
            "the full name is still in the markup, just visually truncated"
        );
        assert!(
            page.contains(r#"class="truncate text-sm font-medium""#),
            "the collapsed row name is not set to truncate: {page}"
        );
    }

    /// A row with no error shows no disclosure — nothing to tap into for a
    /// download that is working.
    #[test]
    fn a_healthy_row_has_no_error_disclosure() {
        let page = render(&moving());
        // Every row is a <details> now (see the module doc on downloads.html)
        // — collapsed for a healthy one — so absence of the tag itself is no
        // longer the signal. The error block itself, styled `text-error`
        // and nowhere else on a row, is.
        assert!(!page.contains("text-error"));
    }

    /// The failure mode this exists to prevent: a root with a hundred-plus
    /// direct children pushing the paste field and the Add/Cancel row off
    /// screen. Every bound has to be there, or a long list is unbounded
    /// again by accident.
    #[test]
    fn the_dialog_and_the_directory_list_are_both_height_bounded_and_scroll() {
        // A non-empty root: an empty picker renders the empty-state message
        // instead of the scrolling <ul>, which is a different behaviour
        // this test isn't the one pinning (see the empty-state tests).
        let page = Page {
            roots: vec![RootView {
                name: "tv".into(),
                path: "/mnt/kontent/tv".into(),
            }],
            rows: vec![],
            aria2_unreachable: false,
        }
        .render()
        .unwrap();
        assert!(
            page.contains("max-h-[85dvh]"),
            "dialog has no overall height cap: {page}"
        );
        assert!(
            page.contains("max-h-[40vh]") && page.contains("overflow-y-auto"),
            "directory list has no height cap or does not scroll: {page}"
        );
    }

    /// The header carries no app name — the person already knows what they
    /// opened, and on a phone in portrait that text only costs the vertical
    /// space the download button could use instead. `<title>` is unrelated:
    /// that names the browser tab and stays.
    ///
    /// The button's own label went too, so the name it is asserted on here is
    /// `aria-label` rather than text. That is the part worth holding: its
    /// icon is `aria-hidden`, so an `aria-label` dropped from this element
    /// leaves the only control on the page announcing as nothing.
    #[test]
    fn the_header_is_only_the_add_button_not_a_name_plus_one() {
        let page = Page {
            roots: vec![],
            rows: vec![],
            aria2_unreachable: false,
        }
        .render()
        .unwrap();
        let header_start = page.find("<header").expect("page has a header");
        let header_end = page.find("</header>").expect("page has a header");
        let header = &page[header_start..header_end];
        assert!(
            !header.contains("mariastew") && !header.contains("<h1"),
            "the app name is still in the header: {header}"
        );
        assert!(
            header.contains("btn-lg") && header.contains(r#"aria-label="Add download""#),
            "the header is not a single prominent primary action: {header}"
        );
    }

    /// The one thing worth seeing the instant the dialog opens is the
    /// magnet field — the destination matters (#257) but is a second
    /// decision, not the first one, so it starts folded away rather than
    /// dumping a directory tree in front of an empty paste field. Neither
    /// `<details>` carries `open`: Askama has no way to emit a boolean
    /// attribute conditionally-absent other than leaving it out, so its
    /// absence here is the whole assertion.
    #[test]
    fn the_destination_picker_starts_collapsed_behind_the_magnet_field() {
        let page = Page {
            roots: vec![],
            rows: vec![],
            aria2_unreachable: false,
        }
        .render()
        .unwrap();
        let magnet_pos = page.find(r#"name="magnet""#).expect("magnet field");
        let details_pos = page.find("<details").expect("a destination disclosure");
        assert!(
            magnet_pos < details_pos,
            "the destination picker is not folded behind the magnet field: {page}"
        );
        assert!(
            !page.contains("<details open"),
            "a details element opens by default instead of on tap: {page}"
        );
    }

    /// The gap the owner actually hit: drilling into a real, empty folder
    /// rendered nothing, indistinguishable from the picker being broken.
    #[test]
    fn an_empty_folder_says_so_instead_of_rendering_nothing() {
        let browse = Browse {
            parent: Some("/mnt/kontent/movies".into()),
            path: "/mnt/kontent/movies/downloads".into(),
            label: "movies/downloads".into(),
            dirs: vec![],
        }
        .render()
        .unwrap();
        assert!(
            browse.contains("This folder is empty"),
            "no empty-state message for a real, empty directory: {browse}"
        );
        assert!(
            !browse.contains("<ul class"),
            "an empty list still rendered a <ul>: {browse}"
        );
    }

    /// A root with nothing under it is a configuration problem, not a
    /// browsing dead end — worth a different message from an ordinary empty
    /// folder, since there's nothing to create your way out of it here.
    #[test]
    fn no_configured_roots_gets_its_own_empty_state() {
        let browse = Browse {
            parent: None,
            path: String::new(),
            label: String::new(),
            dirs: vec![],
        }
        .render()
        .unwrap();
        assert!(browse.contains("No destinations are configured"));
    }

    /// The listing left on screen during a browse belongs to the folder being
    /// left, so dimming it showed the wrong answer legibly for the whole of a
    /// multi-second wait. Both halves are asserted together because either
    /// one alone is the bug: a skeleton that never covers anything, or a list
    /// hidden with nothing put in its place.
    #[test]
    fn the_previous_listing_is_covered_by_a_skeleton_while_browsing() {
        let browse = Browse {
            parent: Some("/mnt/kontent".into()),
            path: "/mnt/kontent/tv".into(),
            label: "tv".into(),
            dirs: vec![DirView {
                name: "Some Show".into(),
                path: "/mnt/kontent/tv/Some Show".into(),
            }],
        }
        .render()
        .unwrap();
        assert!(
            browse.contains(r#"class="skeleton"#),
            "no skeleton rows to stand in for the listing: {browse}"
        );
        assert!(
            browse.contains(r#"data-show="$browsing""#),
            "the skeleton is not gated on the in-flight signal: {browse}"
        );
        assert!(
            browse.contains(r#"data-class:invisible="$browsing""#),
            "the stale listing is still readable underneath: {browse}"
        );
        assert!(
            !browse.contains("data-class:opacity-50"),
            "the old dim-the-stale-list treatment is still applied: {browse}"
        );
    }

    /// `invisible`, not `hidden`: the picker is a bottom sheet, so a list that
    /// gives up its box mid-wait resizes it under the thumb that just tapped
    /// and resizes it back a second later.
    #[test]
    fn the_hidden_listing_keeps_the_space_it_occupied() {
        let browse = Browse {
            parent: None,
            path: String::new(),
            label: String::new(),
            dirs: vec![DirView {
                name: "tv".into(),
                path: "/mnt/kontent/tv".into(),
            }],
        }
        .render()
        .unwrap();
        assert!(
            !browse.contains("data-class:hidden"),
            "the listing collapses its box instead of only going invisible: {browse}"
        );
    }

    /// Creating a folder answers with the same picker after the same readdir,
    /// and the indicator plugin only counts requests raised by its own
    /// element — so the signal `#picker` sets says nothing about this button
    /// and pressing it showed nothing at all.
    #[test]
    fn creating_a_folder_shows_the_same_wait_as_browsing_does() {
        let browse = Browse {
            parent: None,
            path: String::new(),
            label: String::new(),
            dirs: vec![],
        }
        .render()
        .unwrap();
        let mkdir = browse
            .split_once("@post('/mkdir'")
            .expect("a create-folder button")
            .0;
        let tag = &mkdir[mkdir.rfind("<button").expect("a button tag")..];
        assert!(
            tag.contains(r#"data-indicator="browsing""#),
            "the create-folder button raises a request with no indicator: {tag}"
        );
    }

    /// Loading state and the corresponding disable: `data-indicator` and
    /// `data-attr:disabled` are the two attributes that turn "the owner
    /// tapped Add three times because nothing seemed to happen" into a
    /// button that visibly can't be tapped again mid-flight.
    #[test]
    fn the_add_button_shows_a_loading_state_and_disables_itself_in_flight() {
        let page = Page {
            roots: vec![],
            rows: vec![],
            aria2_unreachable: false,
        }
        .render()
        .unwrap();
        assert!(page.contains(r#"data-indicator="adding""#));
        assert!(page.contains(r#"data-attr:disabled="$adding""#));
        assert!(page.contains("loading-spinner"));
    }

    /// The whole point: a 400 the owner will actually hit (magnets only,
    /// destination outside a root) must show *something* in the dialog,
    /// not silently do nothing — the exact bug already fixed once for the
    /// button itself, back for a different reason.
    #[test]
    fn a_failed_add_shows_its_message_instead_of_doing_nothing() {
        let page = Page {
            roots: vec![],
            rows: vec![],
            aria2_unreachable: false,
        }
        .render()
        .unwrap();
        assert!(page.contains(r#"data-show="$addStatus === 'error'""#));
        assert!(page.contains(r#"data-text="$addMessage""#));
    }

    /// A successful add needs to be seen, not inferred later from a row
    /// that quietly appeared: the dialog closes, the field clears, and a
    /// toast says so — all driven by one signal the server sets once.
    #[test]
    fn a_successful_add_closes_the_dialog_and_confirms() {
        let page = Page {
            roots: vec![],
            rows: vec![],
            aria2_unreachable: false,
        }
        .render()
        .unwrap();
        assert!(page.contains(r#"data-effect="if ($addStatus === 'ok') el.close()""#));
        assert!(page.contains(r#"$magnet.value = ''"#));
        assert!(page.contains(r#"data-show="$addStatus === 'ok'""#));
        assert!(page.contains("Added"));
    }

    /// The toast clears the signal it reads, from a trigger Datastar owns. A
    /// plain `setTimeout` writing a signal was tried and rejected: the write
    /// happens outside Datastar's batch, `data-show` never picks it up, and the
    /// toast stays on screen forever with no error anywhere.
    #[test]
    fn the_toast_clears_itself_from_a_trigger_datastar_owns() {
        let page = Page {
            roots: vec![],
            rows: vec![],
            aria2_unreachable: false,
        }
        .render()
        .unwrap();
        assert!(page.contains("data-on-signal-patch__delay.3s="));
        // Guarded on the value it clears, so the clear's own patch fires this
        // once more and finds nothing to do. Unguarded, it writes every three
        // seconds for the life of the page.
        assert!(page.contains("if ($addStatus === 'ok') { $addStatus = ''"));
        assert!(
            !page.contains("setTimeout(() =>"),
            "a bare setTimeout call writing a signal does not get picked up by data-show: {page}"
        );
    }

    /// Two flat signals, never one `$add` object. A nested signal is tracked
    /// only through its parent, so a reader of `$add.status` alone does not
    /// re-run when the server patches it — the dialog, the toast and the error
    /// each stop working with no error anywhere, which is why every reader of
    /// the nested shape needed a `JSON.stringify($add)` prefix beside it.
    #[test]
    fn the_add_contract_is_flat_signals() {
        let page = Page {
            roots: vec![],
            rows: vec![],
            aria2_unreachable: false,
        }
        .render()
        .unwrap();
        assert!(page.contains(r#"data-signals__ifmissing="{addStatus: '', addMessage: ''}""#));
        assert!(
            !page.contains("$add."),
            "a nested add signal is back: {page}"
        );
        assert!(
            !page.contains("JSON.stringify($add"),
            "the prefix a nested signal needs is back, so the shape is too: {page}"
        );
    }

    /// A template naming a helper the module does not define throws at click
    /// time and nowhere else: no build step sees the split, so a rename on one
    /// side of it is otherwise silent until someone presses the button.
    #[test]
    fn every_ms_helper_a_template_calls_is_defined() {
        const SCRIPT: &str = include_str!("../assets/app.js");
        let page = Page {
            roots: vec![],
            rows: vec![],
            aria2_unreachable: false,
        }
        .render()
        .unwrap();
        // `Page` renders the picker inline, so this covers browse.html too.
        let mut called: Vec<&str> = page
            .match_indices("ms.")
            .filter(|(i, _)| {
                page[..*i]
                    .chars()
                    .next_back()
                    .is_none_or(|c| !c.is_alphanumeric() && c != '_' && c != '$' && c != '.')
            })
            .filter_map(|(i, _)| page[i + 3..].split_once('('))
            .map(|(name, _)| name)
            .collect();
        called.sort_unstable();
        called.dedup();
        assert!(
            !called.is_empty(),
            "no ms.* helper calls found at all: {page}"
        );
        for name in called {
            assert!(
                SCRIPT.contains(&format!("{name}(")),
                "a template calls ms.{name}() but assets/app.js does not define it"
            );
        }
    }

    /// A finished row used to look exactly like every other row except for
    /// a word in an outlined badge — easy to miss in a list being scanned
    /// quickly. Filled and checked is the one state meant to pop.
    #[test]
    fn a_finished_row_gets_a_filled_badge_and_the_rest_do_not() {
        let finished = render(&Download {
            completed_length: 1_073_741_824,
            download_speed: 0,
            ..moving()
        });
        assert!(finished.contains("badge-success"));
        assert!(!render(&moving()).contains("badge-success"));
    }

    /// A finished torrent is one press from being done with, and the press
    /// keeps every file — so the button says so and is coloured like the badge
    /// beside it, rather than reading as the quiet sibling of the destructive
    /// one it shares a slot with.
    #[test]
    fn a_finished_row_offers_done_and_an_unfinished_one_offers_the_destructive_button() {
        let finished = render(&Download {
            completed_length: 1_073_741_824,
            download_speed: 0,
            ..moving()
        });
        assert!(finished.contains("Done"), "{finished}");
        assert!(!finished.contains("btn-error"));

        let unfinished = render(&moving());
        assert!(unfinished.contains("Delete download"), "{unfinished}");
    }

    /// A row offers exactly two controls, and every existing assertion here
    /// was about *which* — all of them pass just as well when a control
    /// appears twice. It did: resolving a merge nested this whole block
    /// inside its own `finished` branch, and a finished row shipped with two
    /// Pause buttons above its Done. Counting is the only thing that sees
    /// that, so this counts.
    #[test]
    fn a_row_offers_each_control_once() {
        for (label, html) in [
            (
                "finished",
                render(&Download {
                    completed_length: 1_073_741_824,
                    download_speed: 0,
                    ..moving()
                }),
            ),
            ("unfinished", render(&moving())),
            (
                "paused",
                render(&Download {
                    status: Status::Paused,
                    ..moving()
                }),
            ),
        ] {
            assert_eq!(
                html.matches("<button").count(),
                2,
                "a {label} row should offer two controls: {html}"
            );
            for control in ["/pause')", "/resume')", "/remove')"] {
                assert!(
                    html.matches(control).count() <= 1,
                    "a {label} row repeats {control}: {html}"
                );
            }
        }
    }

    /// #316: the press had nothing to show for itself. aria2 takes a moment to
    /// let go and the list is redrawn from aria2 once a second, so a row being
    /// removed kept reading "ready" beside a button that could be pressed
    /// again — which is what "it does nothing" was. Every control goes and the
    /// state says what is happening.
    #[test]
    fn a_row_being_cleared_says_so_and_offers_nothing_to_press() {
        let seeding = Download {
            completed_length: 1_073_741_824,
            download_speed: 0,
            ..moving()
        };
        let html = render_row(&seeding, Vec::new(), true);
        assert!(html.contains("clearing"), "{html}");
        assert!(html.contains("loading-spinner"), "{html}");
        assert!(
            !html.contains("data-on:click"),
            "a row on its way out has nothing worth pressing: {html}"
        );
        assert!(
            !html.contains("badge-success"),
            "a row being cleared is not finished with: {html}"
        );
    }

    /// The collapsed half of a row, which is what these assert about — the
    /// rate and the time left are also in the readings panel below it, so
    /// searching the whole document would pass on markup that never promoted
    /// anything.
    fn summary(page: &str) -> String {
        let start = page.find("<summary").expect("a row has a summary");
        let end = page.find("</summary>").expect("a row has a summary");
        page[start..end].to_string()
    }

    /// #308: the two numbers that answer "will this be done tonight" were a
    /// tap away, behind the same disclosure as the piece size and the
    /// infohash. They now sit on the destination's line without one.
    #[test]
    fn the_collapsed_row_shows_the_rate_and_the_time_left() {
        // 512 MiB left at 1 MiB/s.
        let summary = summary(&render(&moving()));
        assert!(summary.contains("1.00 MiB/s"), "no rate: {summary}");
        assert!(summary.contains("8m 32s left"), "no time left: {summary}");
    }

    /// Nothing is moving, so there is no rate to show and no rate to divide
    /// the remaining bytes by — a "0 B/s · 0s left" on a finished row is two
    /// measurements nobody took. The badge already says "ready".
    #[test]
    fn an_idle_row_shows_neither_and_keeps_the_dash_in_the_readings() {
        let page = render(&Download {
            completed_length: 1_073_741_824,
            download_speed: 0,
            ..moving()
        });
        let summary = summary(&page);
        assert!(
            !summary.contains("B/s") && !summary.contains("left"),
            "an idle row still shows a rate or a countdown: {summary}"
        );
        assert!(page.contains("—"), "the readings lost their dash: {page}");
    }

    /// The destination shares its line now, and a flex child will not shrink
    /// to wrap without `min-w-0` — it overflows the row instead, which is the
    /// bug this markup exists to avoid (see the picker's own path, #257).
    #[test]
    fn the_destination_can_still_shrink_and_wrap_beside_the_rate() {
        let summary = summary(&render(&Download {
            dir: "/mnt/kontent/tv/Show.Name.S01.2160p.UHD.BluRay.REMUX.HEVC.DTS-HD.MA.5.1/S01"
                .to_string(),
            ..moving()
        }));
        assert!(
            summary.contains("min-w-0") && summary.contains("break-words"),
            "the destination cannot wrap or shrink in its flex row: {summary}"
        );
    }

    /// The other half of "idk where it has put the file": every row shows
    /// its destination without a tap, not just the errored ones.
    #[test]
    fn every_row_shows_its_destination_directory() {
        let page = render(&Download {
            dir: "/mnt/kontent/tv/Show/S01".to_string(),
            ..moving()
        });
        assert!(page.contains("/mnt/kontent/tv/Show/S01"));
    }

    /// The ticket's first half (#298): a row that had nothing to say about
    /// itself beyond a percentage. These are the readings that answer "how
    /// long", "is it giving anything back", and "how is aria2 cutting this
    /// up" — none of which reached the page before.
    #[test]
    fn the_expanded_row_carries_the_readings_a_percentage_cannot() {
        let page = render(&Download {
            upload_length: 268_435_456,
            piece_length: 4_194_304,
            num_pieces: 256,
            info_hash: Some("d1e2f3a4b5c6".to_string()),
            ..moving()
        });
        // 512 MiB left at 1 MiB/s.
        assert!(page.contains("8m 32s"), "no eta: {page}");
        assert!(page.contains("256 MiB"), "nothing uploaded shown: {page}");
        assert!(page.contains("0.50"), "no share ratio: {page}");
        assert!(
            page.contains("256 pieces × 4.00 MiB"),
            "no piece shape: {page}"
        );
        assert!(page.contains("d1e2f3a4b5c6"), "no infohash: {page}");
    }

    /// aria2 fills `errorMessage` in for some failures and leaves it empty
    /// for plenty of others, and a row that failed with nothing written on it
    /// was the ordinary shape of "it broke and nothing says why". The code is
    /// always there.
    #[test]
    fn a_failure_with_no_message_still_explains_itself_from_the_code() {
        let page = render(&Download {
            status: Status::Error,
            error_message: None,
            error_code: Some(9),
            ..moving()
        });
        assert!(page.contains("text-error"), "no error block: {page}");
        assert!(page.contains("not enough disk space"), "{page}");
    }

    /// An empty `errorMessage` is not a message. Rendering it left an empty
    /// line above the code, which reads as the explanation having gone
    /// missing rather than never having been there.
    #[test]
    fn an_empty_error_message_is_treated_as_no_message() {
        let page = render(&Download {
            status: Status::Error,
            error_message: Some(String::new()),
            error_code: Some(9),
            ..moving()
        });
        assert!(page.contains("aria2 code 9 — not enough disk space"));
        assert!(
            !page.contains("<p></p>"),
            "an empty message rendered: {page}"
        );
    }

    /// What the garbage filter threw away reached the disk and the pod's log
    /// and nowhere else, so "why did it not download that one" had no answer
    /// on the page. A deselected file is listed, marked, and counted.
    #[test]
    fn the_file_list_shows_what_was_kept_and_what_the_filter_refused() {
        let page = render(&Download {
            files: vec![
                file(
                    1,
                    "/mnt/kontent/movies/Nightfall/PACKGRP.nfo",
                    473,
                    0,
                    false,
                ),
                file(
                    2,
                    "/mnt/kontent/movies/Nightfall/Nightfall.Harbour.mp4",
                    1000,
                    500,
                    true,
                ),
                file(
                    3,
                    "/mnt/kontent/movies/Nightfall/Other/COVERART.jpg",
                    53_226,
                    0,
                    false,
                ),
            ],
            ..moving()
        });
        assert!(page.contains("keeping 1 of 3"), "{page}");
        assert!(page.contains("2 skipped"), "{page}");
        assert!(
            page.contains("PACKGRP.nfo") && page.contains("COVERART.jpg"),
            "{page}"
        );
        assert!(page.contains("Nightfall.Harbour.mp4"), "{page}");
        assert!(page.contains("skipped"), "{page}");
    }

    /// A file list is unbounded — a discography is hundreds of entries, and
    /// this markup is re-sent down the stream every time anything else in its
    /// row moves.
    #[test]
    fn a_very_long_file_list_is_capped_and_says_how_many_it_left_out() {
        let files = (1..=40)
            .map(|i| {
                file(
                    i,
                    &format!("/mnt/kontent/movies/track{i}.flac"),
                    100,
                    0,
                    true,
                )
            })
            .collect();
        let page = render(&Download { files, ..moving() });
        assert!(page.contains("track24.flac"));
        assert!(!page.contains("track25.flac"));
        assert!(page.contains("and 16 more"), "{page}");
    }

    /// The ticket's second half (#298): a panel, per torrent, of what
    /// actually happened to it. Every line here was previously only in the
    /// pod's log.
    #[test]
    fn the_log_panel_lists_a_downloads_history_newest_last() {
        let at =
            |epoch_secs: u64| std::time::UNIX_EPOCH + std::time::Duration::from_secs(epoch_secs);
        let page = render_with_log(
            &moving(),
            vec![
                Entry {
                    at: at(1_754_646_731), // 09:52:11 UTC
                    message: "added — destination /mnt/kontent/movies".to_string(),
                },
                Entry {
                    at: at(1_754_646_853), // 09:54:13 UTC
                    message: "keeping 1 of 3 files, skipping 2 (52.0 KiB)".to_string(),
                },
            ],
        );
        assert!(page.contains("Logs"), "no logs disclosure: {page}");
        assert!(page.contains("added — destination /mnt/kontent/movies"));
        let first = page.find("added —").unwrap();
        let second = page.find("keeping 1 of 3").unwrap();
        assert!(first < second, "the log is not in the order it happened");
    }

    /// A log wants to say *when*, not *how long ago* — every line reading
    /// "2m" says nothing about the order or the gaps, which is the whole of
    /// what a log is read for. The markup carries UTC because the pod has no
    /// timezone; `data-text` rewrites it in the reader's, and `hour12: false`
    /// keeps it to the eight characters the fixed-width column assumes.
    #[test]
    fn a_log_line_is_stamped_with_a_clock_time_the_browser_localises() {
        let page = render_with_log(
            &moving(),
            vec![Entry {
                at: std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_754_646_731),
                message: "added".to_string(),
            }],
        );
        assert!(page.contains(">09:52:11<"), "no UTC fallback: {page}");
        assert!(
            page.contains(
                r#"data-text="new Date(1754646731000).toLocaleTimeString([], {hour12: false})""#
            ),
            "the timestamp is not localised by the browser: {page}"
        );
    }

    #[test]
    fn utc_hms_is_the_time_of_day_from_epoch_millis() {
        assert_eq!(utc_hms(0), "00:00:00");
        assert_eq!(utc_hms(1_754_646_731_000), "09:52:11");
        assert_eq!(utc_hms(86_399_000), "23:59:59");
    }

    /// A download already in aria2 when this pod started has no history here
    /// — an empty panel labelled "Logs" would read as the history having been
    /// lost rather than never having been recorded.
    #[test]
    fn a_download_with_no_history_shows_no_log_panel_at_all() {
        assert!(!render(&moving()).contains("Logs"));
    }

    #[test]
    fn duration_uses_the_two_largest_units_it_needs() {
        assert_eq!(duration(45), "45s");
        assert_eq!(duration(125), "2m 5s");
        assert_eq!(duration(7_320), "2h 2m");
    }
}
