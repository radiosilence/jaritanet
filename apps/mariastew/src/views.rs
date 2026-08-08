//! What the templates are handed.
//!
//! aria2's shapes do not reach a template. Everything a row needs is computed
//! once here — the numbers formatted, the health resolved — so the markup makes
//! no decisions and there is one place to test the ones that matter.

use askama::Template;

use crate::aria2::{Download, Health, Status};

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
    pub down: String,
    pub up: String,
    pub size: String,
    pub done: String,
    pub connections: u32,
    pub seeders: u32,
    pub error: Option<String>,
    /// Only shown alongside `error`, in the disclosure that reveals why a
    /// row failed — nobody needs the destination of a download that is
    /// working.
    pub dir: String,
    pub finished: bool,
    pub paused: bool,
}

/// DaisyUI modifier and the word for it, together — colour alone is never
/// the only way to read a row (see `Row::bar_class`).
///
/// The words are the ones a person would use about a download, not the ones
/// the enum uses about a swarm. `Health::Moving` naming itself "moving" on
/// screen was the giveaway: it is precise about traffic and meaningless to
/// whoever is waiting for a film. Each state now says either what is
/// happening or what is wrong, in the terms of the thing being waited for.
fn bar_class_and_state(health: Health) -> (&'static str, &'static str) {
    match health {
        Health::Moving => ("progress-success", "downloading"),
        Health::Complete => ("progress-success", "ready"),
        Health::Choked => ("progress-warning", "stalled"),
        Health::Blocked => ("progress-error", "can't connect"),
        Health::Errored => ("progress-error", "failed"),
        Health::Dead => ("progress-error", "no seeders"),
        Health::Resolving => ("progress-info", "starting"),
        Health::Paused => ("progress-info", "paused"),
    }
}

impl From<&Download> for Row {
    fn from(d: &Download) -> Self {
        let percent = d.percent();
        let health = d.health();
        let (bar_class, state) = bar_class_and_state(health);
        let (size, done) = d.display_totals();
        Row {
            gid: d.gid.clone(),
            name: d.name().to_string(),
            percent,
            percent_display: percent.map(|p| format!("{p:.0}")),
            health,
            bar_class,
            state,
            down: rate(d.download_speed),
            up: rate(d.upload_speed),
            // Same totals the bar is drawn from, so "80.0 KiB / 6.42 GiB"
            // beside a full bar cannot happen again.
            size: bytes(size),
            done: bytes(done),
            connections: d.connections,
            seeders: d.num_seeders,
            error: d.error_message.clone(),
            dir: d.dir.clone(),
            finished: d.is_finished(),
            paused: d.status == Status::Paused,
        }
    }
}

#[derive(Template)]
#[template(path = "page.html")]
pub struct Page {
    pub roots: Vec<RootView>,
    pub rows: Vec<Row>,
    /// Set when the aria2 poll behind this render failed. The page still
    /// renders — with an empty `rows` and a visible banner — rather than a
    /// blank 500, because a restarted sidecar should not take the UI down
    /// with it.
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

/// The list on its own, pushed down the stream. Its root element carries the
/// same id as the one in the page, which is how Datastar morphs it in place.
#[derive(Template)]
#[template(path = "downloads.html")]
pub struct Downloads {
    pub rows: Vec<Row>,
}

#[derive(Template)]
#[template(path = "browse.html")]
pub struct Browse {
    /// Absent at a root, which is where browsing upward stops.
    pub parent: Option<String>,
    pub path: String,
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

/// A transfer rate, or a dash when nothing is moving — a rate of `0 B/s` reads
/// as a measurement, and an idle row has not measured anything.
pub fn rate(n: u64) -> String {
    if n == 0 {
        return "—".to_string();
    }
    format!("{}/s", bytes(n))
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn rate_at_zero_is_a_dash() {
        assert_eq!(rate(0), "—");
    }

    #[test]
    fn rate_is_bytes_per_second() {
        assert_eq!(rate(1024), "1.00 KiB/s");
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

    #[test]
    fn state_resolving() {
        assert_eq!(
            bar_class_and_state(Health::Resolving),
            ("progress-info", "starting")
        );
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
            page.contains("document.getElementById('add-dialog').showModal()")
                && page.contains(r#"data-on:click=""#),
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
        let page = Downloads {
            rows: vec![Row {
                gid: "abc".into(),
                name: "test.iso".into(),
                percent: Some(50.0),
                percent_display: Some("50".into()),
                health: Health::Moving,
                bar_class: "progress-success",
                state: "downloading",
                down: "1.00 MiB/s".into(),
                up: "0 B/s".into(),
                size: "1.00 GiB".into(),
                done: "512 MiB".into(),
                connections: 1,
                seeders: 1,
                error: None,
                dir: "/mnt/kontent/movies".into(),
                finished: false,
                paused: false,
            }],
        }
        .render()
        .unwrap();
        assert!(page.contains(r#"data-on:click="@post('/downloads/abc/pause')""#));
        assert!(!page.contains("data-on-"));

        let browse = Browse {
            parent: Some("/mnt/tv".into()),
            path: "/mnt/tv/show".into(),
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

    /// A real release name — title and year first, encoding detail last —
    /// with no ellipsis to hide any of it: `line-clamp-2` wraps rather than
    /// truncates, because two folders in the same list can differ only in
    /// that tail (a part number, a disc, a cut), which an end-ellipsis would
    /// hide on exactly the two entries a picker most needs to tell apart.
    #[test]
    fn long_directory_names_wrap_instead_of_being_cut_off() {
        let long_name = "Chungking.Express.1994.Criterion.1080p.BluRay.x265.HEVC.10bit.AAC.5.1";
        let browse = Browse {
            parent: None,
            path: String::new(),
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
        let common = "2046.2004.Criterion.Collection.2160p.UHD.BluRay.REMUX.HEVC.HDR.DTS-HD.MA.5.1";
        let part1 = format!("{common}.PART1");
        let part2 = format!("{common}.PART2");
        let browse = Browse {
            parent: None,
            path: String::new(),
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
    #[test]
    fn the_current_path_wraps_and_can_shrink_in_its_flex_row() {
        let long_path = "/mnt/kontent/movies/Chungking.Express.1994.Criterion.1080p.BluRay.x265.HEVC.10bit.AAC.5.1";
        let browse = Browse {
            parent: Some("/mnt/kontent/movies".into()),
            path: long_path.into(),
            dirs: vec![],
        }
        .render()
        .unwrap();
        assert!(browse.contains(long_path), "the full path must be shown");
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
        let page = Downloads {
            rows: vec![Row {
                gid: "abc123".into(),
                name: "Show.S01E01".into(),
                percent: Some(12.0),
                percent_display: Some("12".into()),
                health: Health::Errored,
                bar_class: "progress-error",
                state: "failed",
                down: "0 B/s".into(),
                up: "0 B/s".into(),
                size: "1.00 GiB".into(),
                done: "128 MiB".into(),
                connections: 0,
                seeders: 0,
                error: Some("No space left on device".into()),
                dir: "/mnt/kontent/tv/Show/S01".into(),
                finished: false,
                paused: false,
            }],
        }
        .render()
        .unwrap();
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
        let long_name = "Chungking.Express.1994.Criterion.1080p.BluRay.x265.HEVC.10bit.AAC.5.1";
        let page = Downloads {
            rows: vec![Row {
                gid: "abc".into(),
                name: long_name.into(),
                percent: Some(50.0),
                percent_display: Some("50".into()),
                health: Health::Moving,
                bar_class: "progress-success",
                state: "downloading",
                down: "1.00 MiB/s".into(),
                up: "0 B/s".into(),
                size: "1.00 GiB".into(),
                done: "512 MiB".into(),
                connections: 1,
                seeders: 1,
                error: None,
                dir: "/mnt/kontent/movies".into(),
                finished: false,
                paused: false,
            }],
        }
        .render()
        .unwrap();
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
        let page = Downloads {
            rows: vec![Row {
                gid: "abc123".into(),
                name: "Show.S01E01".into(),
                percent: Some(50.0),
                percent_display: Some("50".into()),
                health: Health::Moving,
                bar_class: "progress-success",
                state: "downloading",
                down: "1.00 MiB/s".into(),
                up: "0 B/s".into(),
                size: "1.00 GiB".into(),
                done: "512 MiB".into(),
                connections: 1,
                seeders: 1,
                error: None,
                dir: "/mnt/kontent/tv/Show/S01".into(),
                finished: false,
                paused: false,
            }],
        }
        .render()
        .unwrap();
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
            header.contains("btn-lg") && header.contains("Add download"),
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
            dirs: vec![],
        }
        .render()
        .unwrap();
        assert!(browse.contains("No destinations are configured"));
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
        // The JSON.stringify($add) prefix is not decorative — see the
        // comment on this element in page.html. A narrower assertion here
        // (checking only for `$add.status === 'error'`) would pass with the
        // prefix silently deleted, which is exactly the change that breaks
        // this at runtime with no error anywhere.
        assert!(page.contains(r#"data-show="JSON.stringify($add) && $add.status === 'error'""#));
        assert!(page.contains(r#"data-text="JSON.stringify($add) && $add.message""#));
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
        assert!(page.contains("JSON.stringify($add); if ($add.status === 'ok')"));
        assert!(page.contains("add-dialog').close()"));
        assert!(page.contains(r#"[name=magnet]').value = ''"#));
        assert!(page.contains(r#"data-show="JSON.stringify($add) && $add.status === 'ok'""#));
        assert!(page.contains("Added"));
    }

    /// The toast's own dismiss timer: a plain `setTimeout` writing a signal
    /// was tried and rejected — the write happens outside Datastar's own
    /// batch, and data-show never picked it up, so the toast stayed on
    /// screen forever with no error anywhere. `on-interval` wraps its
    /// callback in that batch and is what actually clears it.
    #[test]
    fn the_toast_reset_uses_on_interval_not_a_bare_settimeout() {
        let page = Page {
            roots: vec![],
            rows: vec![],
            aria2_unreachable: false,
        }
        .render()
        .unwrap();
        assert!(page.contains("data-on-interval__duration.3s="));
        // "setTimeout" still appears in the explanatory HTML comment above
        // the interval element — checking for the actual call form, not the
        // bare word, is what keeps this test honest about what regressed.
        assert!(
            !page.contains("setTimeout(() =>"),
            "a bare setTimeout call writing a signal does not get picked up by data-show: {page}"
        );
    }

    /// A finished row used to look exactly like every other row except for
    /// a word in an outlined badge — easy to miss in a list being scanned
    /// quickly. Filled and checked is the one state meant to pop.
    #[test]
    fn a_finished_row_gets_a_filled_badge_and_the_rest_do_not() {
        let make_row = |finished: bool| Row {
            gid: "abc".into(),
            name: "Show.S01E01".into(),
            percent: Some(100.0),
            percent_display: Some("100".into()),
            health: Health::Complete,
            bar_class: "progress-success",
            state: "ready",
            down: "0 B/s".into(),
            up: "0 B/s".into(),
            size: "1.00 GiB".into(),
            done: "1.00 GiB".into(),
            connections: 0,
            seeders: 0,
            error: None,
            dir: "/mnt/kontent/tv/Show/S01".into(),
            finished,
            paused: false,
        };
        let finished = (Downloads {
            rows: vec![make_row(true)],
        })
        .render()
        .unwrap();
        assert!(finished.contains("badge-success"));

        let moving = (Downloads {
            rows: vec![make_row(false)],
        })
        .render()
        .unwrap();
        assert!(!moving.contains("badge-success"));
    }

    /// The other half of "idk where it has put the file": every row shows
    /// its destination without a tap, not just the errored ones.
    #[test]
    fn every_row_shows_its_destination_directory() {
        let page = (Downloads {
            rows: vec![Row {
                gid: "abc".into(),
                name: "Show.S01E01".into(),
                percent: Some(50.0),
                percent_display: Some("50".into()),
                health: Health::Moving,
                bar_class: "progress-success",
                state: "downloading",
                down: "1.00 MiB/s".into(),
                up: "0 B/s".into(),
                size: "1.00 GiB".into(),
                done: "512 MiB".into(),
                connections: 1,
                seeders: 1,
                error: None,
                dir: "/mnt/kontent/tv/Show/S01".into(),
                finished: false,
                paused: false,
            }],
        })
        .render()
        .unwrap();
        assert!(page.contains("/mnt/kontent/tv/Show/S01"));
    }
}
