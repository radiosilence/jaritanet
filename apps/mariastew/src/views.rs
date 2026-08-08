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

/// The browse URL for a path, percent-encoded here rather than in the markup.
///
/// A directory name is attacker-supplied — this service creates directories on
/// request — and the link that opens one is a Datastar expression, so the name
/// would otherwise land inside a JavaScript string literal. HTML escaping does
/// not help there: the browser decodes `&#x27;` back to a quote before the
/// expression is ever parsed, so a folder named `'+alert(1)+'` would run.
/// Percent-encoding turns every quote into `%27`, which cannot close anything,
/// and leaves the template with a plain URL and no concatenation in it.
pub fn browse_href(path: &str) -> String {
    let mut out = String::from("/browse?path=");
    for b in path.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
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
    pub finished: bool,
    pub paused: bool,
}

/// DaisyUI modifier and the word for it, together — colour alone is never
/// the only way to read a row (see `Row::bar_class`).
fn bar_class_and_state(health: Health) -> (&'static str, &'static str) {
    match health {
        Health::Moving => ("progress-success", "moving"),
        Health::Complete => ("progress-success", "complete"),
        Health::Choked => ("progress-warning", "choked"),
        Health::Blocked => ("progress-error", "blocked"),
        Health::Errored => ("progress-error", "errored"),
        Health::Dead => ("progress-error", "dead"),
        Health::Resolving => ("progress-info", "resolving"),
        Health::Paused => ("progress-info", "paused"),
    }
}

impl From<&Download> for Row {
    fn from(d: &Download) -> Self {
        let percent = d.percent();
        let health = d.health();
        let (bar_class, state) = bar_class_and_state(health);
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
            size: bytes(d.total_length),
            done: bytes(d.completed_length),
            connections: d.connections,
            seeders: d.num_seeders,
            error: d.error_message.clone(),
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

    /// The breakout this encoding exists to stop: a directory the user can
    /// create, whose name closes the JavaScript string it would otherwise be
    /// pasted into.
    #[test]
    fn browse_href_percent_encodes_quotes_so_a_name_cannot_close_a_js_string() {
        let href = browse_href("/mnt/kontent/tv/'+alert(1)+'");
        assert!(!href.contains('\''), "a quote survived: {href}");
        assert!(!href.contains('('), "a paren survived: {href}");
        assert!(href.contains("%27"));
    }

    #[test]
    fn browse_href_leaves_unreserved_characters_alone_and_encodes_separators() {
        assert_eq!(
            browse_href("/mnt/kontent/tv/Show-Name_2.0~x"),
            "/browse?path=%2Fmnt%2Fkontent%2Ftv%2FShow-Name_2.0~x"
        );
    }

    #[test]
    fn browse_href_encodes_spaces_and_non_ascii() {
        let href = browse_href("/mnt/tv/Naïve Show S02");
        assert!(!href.contains(' '));
        assert!(href.contains("%20"));
        assert!(href.is_ascii());
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
            ("progress-success", "moving")
        );
    }

    #[test]
    fn state_complete() {
        assert_eq!(
            bar_class_and_state(Health::Complete),
            ("progress-success", "complete")
        );
    }

    #[test]
    fn state_choked() {
        assert_eq!(
            bar_class_and_state(Health::Choked),
            ("progress-warning", "choked")
        );
    }

    #[test]
    fn state_blocked() {
        assert_eq!(
            bar_class_and_state(Health::Blocked),
            ("progress-error", "blocked")
        );
    }

    #[test]
    fn state_errored() {
        assert_eq!(
            bar_class_and_state(Health::Errored),
            ("progress-error", "errored")
        );
    }

    #[test]
    fn state_dead() {
        assert_eq!(
            bar_class_and_state(Health::Dead),
            ("progress-error", "dead")
        );
    }

    #[test]
    fn state_resolving() {
        assert_eq!(
            bar_class_and_state(Health::Resolving),
            ("progress-info", "resolving")
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
            page.contains(r#"data-on:click="document.getElementById('add-dialog').showModal()""#),
            "add-dialog button markup: {page}"
        );
        assert!(
            !page.contains("data-on-"),
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
                state: "moving",
                down: "1.00 MiB/s".into(),
                up: "0 B/s".into(),
                size: "1.00 GiB".into(),
                done: "512 MiB".into(),
                connections: 1,
                seeders: 1,
                error: None,
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
}
