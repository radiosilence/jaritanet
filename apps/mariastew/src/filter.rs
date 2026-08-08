//! Which files in a torrent are worth downloading.
//!
//! Ported from `clean-dls` in the dotfiles, which deleted these after the fact.
//! Choosing not to fetch them is better than sweeping up afterwards for a
//! reason beyond bandwidth: downloads land directly in the library, so anything
//! written there is *in* the library, and nothing else ever sees the files.
//!
//! Global rather than per-destination, because the scope is television and
//! film. There is no album art to protect, so scene garbage is garbage
//! everywhere and one list serves every download.
//!
//! The tracker-spam rules below are not part of that port — see the comment
//! at their definition for why the port stops being exact there.

fn basename(path: &str) -> &str {
    match path.rfind('/') {
        Some(idx) => &path[idx + 1..],
        None => path,
    }
}

/// Whether a stem (basename with its extension removed) names a sample.
///
/// The boundaries are spelled out rather than matched as a `*sample*`
/// substring so `resampled` and `downsample` don't get caught in the net —
/// "sample" has to be a whole word-like segment, delimited by the stem's
/// edges or a `-`, `_` or space.
fn is_sample(stem: &str) -> bool {
    stem == "sample"
        || stem.starts_with("sample-")
        || stem.starts_with("sample_")
        || stem.starts_with("sample ")
        || stem.ends_with("-sample")
        || stem.ends_with("_sample")
        || stem.contains("-sample-")
        || stem.contains("_sample_")
        || stem.contains("-sample_")
        || stem.contains("_sample-")
}

/// A trailing Windows duplicate-file marker, stripped before judging the
/// rest of a `.txt` stem. `clean-dls` never had to think about this — it
/// swept a finished download, where a second copy just overwrites the
/// first — but this filter decides before anything lands, so the same
/// tracker-spam file re-fetched (a repeat download, a re-seeded release)
/// can carry Windows' "already have one of these" annotation on top of the
/// name that actually identifies it. Input is already lowercased by the
/// caller.
fn strip_copy_suffix(stem: &str) -> &str {
    stem.strip_suffix(" - copy").unwrap_or(stem)
}

/// Whether a `.txt` stem is nothing but a bare hostname — `sitename.tld` and
/// nothing else, the shape of `AhaShare.com.txt`.
///
/// Deliberately narrow: the *entire* stem has to be domain-shaped, not
/// merely contain something that looks like one. That is what keeps a real
/// two-word name like `Making.Of.txt` off the list (`of` is a two-letter
/// final label, under the three-letter floor below) and a scene-style
/// sidecar like `Show.Name.S01E01.txt` off it too (the final label has
/// digits in it, never true of a TLD). The floor is deliberately three
/// letters rather than two — real tracker sites do use two-letter TLDs
/// (`.to`, `.is`), so this misses some of them, but a two-letter floor
/// starts matching short, real, two-word names too easily, and wrongly
/// deleting a real file is the failure that cannot be undone.
fn looks_like_a_bare_hostname(stem: &str) -> bool {
    if stem.is_empty() || stem.contains(' ') {
        return false;
    }
    let labels: Vec<&str> = stem.split('.').collect();
    if labels.len() < 2 || labels.iter().any(|l| l.is_empty()) {
        return false;
    }
    let tld = labels[labels.len() - 1];
    (3..=4).contains(&tld.len())
        && tld.bytes().all(|b| b.is_ascii_alphabetic())
        && labels
            .iter()
            .all(|l| l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}

/// Whether a path is scene garbage.
pub fn is_garbage(path: &str) -> bool {
    let base = basename(path);
    let lbase = base.to_lowercase();

    if lbase == ".ds_store" {
        return true;
    }
    if lbase.ends_with(".nfo")
        || lbase.ends_with(".png")
        || lbase.ends_with(".jpg")
        || lbase.ends_with(".jpeg")
        || lbase.ends_with(".sfv")
    {
        return true;
    }
    if lbase.starts_with("._") {
        return true;
    }
    if matches!(
        lbase.as_str(),
        "readme.txt" | "info.txt" | "nfo.txt" | "file_id.diz"
    ) {
        return true;
    }

    // Not part of the `clean-dls` port above: that list is four exact names,
    // ported unchanged. This is a judgement call the port never had to make,
    // because `clean-dls` swept a finished download after the fact and an
    // unrecognised `.txt` just sat there until someone deleted it by hand.
    // Here it lands in the library and stays, which is what makes tracker
    // attribution spam ("torrent downloaded from ...", or a bare site
    // domain used as the filename — neither shipped by a scene group, both
    // dragged in by whichever site re-hosted the release) worth catching
    // rather than tolerating. Scoped to `.txt` only, and narrowly, per the
    // two helpers above: keeping a real caption or synopsis file is a minor
    // annoyance, deleting one is not recoverable.
    if let Some(stem) = lbase.strip_suffix(".txt") {
        let stem = strip_copy_suffix(stem);
        if stem.contains("torrent downloaded from") || looks_like_a_bare_hostname(stem) {
            return true;
        }
    }

    let stem = match lbase.rfind('.') {
        Some(idx) => &lbase[..idx],
        None => lbase.as_str(),
    };
    is_sample(stem)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nfo_sfv_and_image_extensions_are_garbage_case_insensitively() {
        assert!(is_garbage("show.nfo"));
        assert!(is_garbage("show.sfv"));
        assert!(is_garbage("poster.png"));
        assert!(is_garbage("cover.jpg"));
        assert!(is_garbage("cover.jpeg"));
        assert!(is_garbage("POSTER.JPG"));
        assert!(is_garbage("Show.NFO"));
    }

    #[test]
    fn ds_store_is_garbage_in_any_case() {
        assert!(is_garbage(".DS_Store"));
        assert!(is_garbage(".ds_store"));
        assert!(is_garbage(".Ds_Store"));
    }

    #[test]
    fn appledouble_files_are_garbage() {
        assert!(is_garbage("._show.mkv"));
        assert!(is_garbage("._.DS_Store"));
    }

    #[test]
    fn named_scene_files_are_garbage_case_insensitively() {
        assert!(is_garbage("readme.txt"));
        assert!(is_garbage("README.TXT"));
        assert!(is_garbage("info.txt"));
        assert!(is_garbage("nfo.txt"));
        assert!(is_garbage("file_id.diz"));
        assert!(is_garbage("FILE_ID.DIZ"));
    }

    /// The three real filenames a fake torrent left in the library, verbatim.
    #[test]
    fn real_tracker_spam_filenames_are_garbage() {
        assert!(is_garbage("Other/AhaShare.com.txt"));
        assert!(is_garbage(
            "Other/Torrent downloaded from Demonoid.com - Copy.txt"
        ));
        assert!(is_garbage(
            "Other/Torrent Downloaded From ExtraTorrent.com.txt"
        ));
    }

    #[test]
    fn tracker_spam_is_garbage_regardless_of_case() {
        assert!(is_garbage("AHASHARE.COM.TXT"));
        assert!(is_garbage(
            "torrent downloaded from demonoid.com - copy.txt"
        ));
        assert!(is_garbage("TORRENT DOWNLOADED FROM EXTRATORRENT.COM.TXT"));
    }

    /// The `" - Copy"` suffix combined with a bare-hostname stem rather than
    /// the attribution phrase — the one shape none of the three real names
    /// happens to exercise, since the only one carrying the suffix is caught
    /// by the phrase rule regardless of what follows it.
    #[test]
    fn a_bare_hostname_txt_is_garbage_even_with_a_copy_suffix() {
        assert!(is_garbage("AhaShare.com - Copy.txt"));
    }

    /// The failure mode that matters more: a real `.txt` must never be
    /// caught. None of these has a "torrent downloaded from" phrase, and
    /// none is *only* a bare hostname once the reasons a title can contain a
    /// dot or a short word are accounted for.
    #[test]
    fn legitimate_txt_files_survive() {
        assert!(!is_garbage("synopsis.txt"));
        assert!(!is_garbage("credits.txt"));
        assert!(!is_garbage("notes.txt"));
        // Scene-style sidecar: the final dot-separated label has digits in
        // it, which no TLD does.
        assert!(!is_garbage("Show.Name.S01E01.txt"));
        // Two-letter TLD: the domain-shape rule is deliberately narrower
        // than real-world tracker domains to avoid catching a short
        // two-word name like "Making.Of.txt" — see `looks_like_a_bare_hostname`.
        assert!(!is_garbage("Site.To.txt"));
        assert!(!is_garbage("Making.Of.txt"));
    }

    #[test]
    fn every_sample_form_is_garbage() {
        assert!(is_garbage("sample.mkv"));
        assert!(is_garbage("Sample-something.mkv"));
        assert!(is_garbage("sample_x.avi"));
        assert!(is_garbage("sample thing.mkv"));
        assert!(is_garbage("foo-sample.mkv"));
        assert!(is_garbage("foo_sample.mkv"));
        assert!(is_garbage("a-sample-b.mkv"));
        assert!(is_garbage("a_sample_b.mkv"));
        assert!(is_garbage("a-sample_b.mkv"));
        assert!(is_garbage("a_sample-b.mkv"));
    }

    /// The important half: names that merely contain "sample" as a substring,
    /// without it standing alone as a segment, are real media and must survive.
    #[test]
    fn near_miss_sample_substrings_are_not_garbage() {
        assert!(!is_garbage("resampled.flac"));
        assert!(!is_garbage("downsample.aiff"));
        assert!(!is_garbage("sampler.mkv"));
        assert!(!is_garbage("Presample.mkv"));
        assert!(!is_garbage("samples.mkv"));
        assert!(!is_garbage("Some.Show.S02E01.mkv"));
        assert!(!is_garbage("episode.mp4"));
        assert!(!is_garbage("subtitles.srt"));
        assert!(!is_garbage("movie.mkv"));
    }

    #[test]
    fn only_the_basename_is_judged() {
        assert!(is_garbage("Some.Show/Sample/sample.mkv"));
        assert!(!is_garbage("sampler-pack/episode.mkv"));
    }

    #[test]
    fn empty_path_and_trailing_slash_do_not_panic() {
        assert!(!is_garbage(""));
        assert!(!is_garbage("Some.Show/Sample/"));
    }
}
