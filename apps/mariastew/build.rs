//! Finds `assets/app-<hash>.js`, the output of `mise run js`, and hands its
//! name to `main.rs` as `APP_JS_FILENAME` — `include_str!` needs a literal
//! path, and rolldown decides the hash, so nothing in the Rust source can
//! spell the filename itself.
//!
//! Exactly one match is the point: it is what catches a stale second file
//! left by a `mise run js` that forgot to clean the last hash, same as it
//! catches forgetting to run `mise run js` at all.

use std::fs;

fn main() {
    println!("cargo:rerun-if-changed=assets");

    let matches: Vec<_> = fs::read_dir("assets")
        .expect("apps/mariastew/assets should exist")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("app-") && name.ends_with(".js"))
        .collect();

    let filename = match matches.as_slice() {
        [one] => one,
        [] => panic!("no assets/app-*.js found — run `mise run js` before building mariastew"),
        many => panic!(
            "found {} assets/app-*.js files ({many:?}) — `mise run js` should have removed the old hash before writing the new one",
            many.len()
        ),
    };

    println!("cargo:rustc-env=APP_JS_FILENAME={filename}");
}
