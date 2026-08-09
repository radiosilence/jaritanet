#!/usr/bin/env -S node --experimental-strip-types

/**
 * Renders `icons/icon.svg` into everything `templates/page.html` links, with
 * `rsvg-convert` (brew install librsvg). The outputs are committed, so neither
 * the container build nor a plain `cargo build` learns about librsvg —
 * `main.rs` `include_bytes!`s them the same way it does the stylesheet.
 *
 * Two shapes come out of the one drawing, and the difference is who rounds the
 * corners.
 *
 * Anything shown as given keeps the tile's own rounded corner: the favicon,
 * and the manifest's `purpose: any` pair, which is what an install prompt, a
 * task switcher and a file browser put on screen. Only what is definitely
 * going to be masked renders full-bleed — the `maskable` pair, which Android
 * cuts to whatever the launcher's shape is that year, and `apple-touch-icon`,
 * which iOS always cuts to a squircle. A pre-rounded tile handed to a mask is
 * rounded twice and shows the page's background in the gap.
 *
 * That split is the reason there are two of each size rather than one doing
 * both jobs: a single full-bleed icon declared `any maskable` is a bare square
 * everywhere it is not masked.
 *
 * And it is why `icon.svg` keeps its tile and its mark in separate elements —
 * the full-bleed variants are composed from `#mark` alone rather than from a
 * second drawing that would have to be kept in step with the first.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Android guarantees only the central 80% of a maskable icon survives the
 *  mask; iOS's squircle is far less aggressive, so it gets more of the mark. */
const MASKABLE_SAFE = 0.8;
const APPLE_INSET = 0.88;

/** ICO carries 16 and 32 for the tab and 48 for a Windows shortcut. Windows is
 *  the only reason this file exists at all — every browser here prefers the
 *  SVG — so it stops where Windows stops caring. */
const ICO_SIZES = [16, 32, 48];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "icons/icon.svg");
const assets = join(root, "assets");

const svg = readFileSync(source, "utf8");

const mark = svg.match(/<g id="mark">([\s\S]*?)<\/g>/)?.[1];
const tileFill = svg.match(/id="tile"[^>]*fill="([^"]+)"/)?.[1];
if (mark === undefined || tileFill === undefined) {
  throw new Error(
    `${source} must hold a <rect id="tile" … fill="…"> and a <g id="mark">…</g> — see the module docs for why they are separate`,
  );
}

/** The mark on an unrounded tile, scaled about the centre of the 64 grid. */
const fullBleed = (scale: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${tileFill}"/><g transform="translate(32 32) scale(${scale}) translate(-32 -32)">${mark}</g></svg>`;

const scratch = mkdtempSync(join(tmpdir(), "mariastew-icons-"));

/** `rsvg-convert` reads a file rather than stdin so a relative reference in the
 *  source would still resolve; nothing uses one yet. */
function render(svgText: string, size: number, out: string) {
  const input = join(scratch, "in.svg");
  writeFileSync(input, svgText);
  execFileSync("rsvg-convert", [
    input,
    "-w",
    String(size),
    "-h",
    String(size),
    "-o",
    out,
  ]);
}

/** ICO is a 6-byte header, one 16-byte directory entry per image, then the
 *  payloads — which are allowed to be whole PNG files, so the sizes packed
 *  here are the PNGs rsvg already wrote rather than re-encoded bitmaps. */
function ico(pngs: Buffer[], sizes: number[]) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(pngs.length, 4);

  let offset = header.length + pngs.length * 16;
  const entries = pngs.map((png, i) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(sizes[i], 0); // 0 would mean 256
    entry.writeUInt8(sizes[i], 1);
    entry.writeUInt8(0, 2); // palette size, 0 for truecolour
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...pngs]);
}

writeFileSync(join(assets, "icon.svg"), svg);

render(fullBleed(APPLE_INSET), 180, join(assets, "apple-touch-icon.png"));
for (const size of [192, 512]) {
  render(svg, size, join(assets, `icon-${size}.png`));
  render(
    fullBleed(MASKABLE_SAFE),
    size,
    join(assets, `icon-${size}-maskable.png`),
  );
}

const frames = ICO_SIZES.map((size) => {
  const out = join(scratch, `${size}.png`);
  render(svg, size, out);
  return readFileSync(out);
});
writeFileSync(join(assets, "favicon.ico"), ico(frames, ICO_SIZES));

rmSync(scratch, { recursive: true, force: true });

console.log(
  `icon.svg, favicon.ico (${ICO_SIZES.join("/")}), apple-touch-icon.png, icon-{192,512}.png, icon-{192,512}-maskable.png`,
);
