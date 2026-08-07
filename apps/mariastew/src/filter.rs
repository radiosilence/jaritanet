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
