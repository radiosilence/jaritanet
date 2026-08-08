#!/usr/bin/env -S node --experimental-strip-types

/**
 * Rasterises the icon SVGs with `rsvg-convert` (brew install librsvg).
 *
 * The SVG is the source; every PNG here is a build output committed beside it
 * so a browser that will not take `image/svg+xml` — and every OS that wants a
 * real bitmap for a home screen — has one without a toolchain being present at
 * build time.
 *
 * 16 is the size that decides an icon: it is the tab, and a mark that survives
 * it survives everything above it. Rendered directly at each size rather than
 * downsampled from 512, so the shapes land on whole pixels.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZES = [512, 192, 180, 64, 32, 16];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, process.argv[2] ?? "icons/candidates");
const out = join(dir, "png");

mkdirSync(out, { recursive: true });

const svgs = readdirSync(dir).filter((f) => f.endsWith(".svg"));
if (svgs.length === 0) throw new Error(`no .svg files in ${dir}`);

for (const svg of svgs) {
  const name = basename(svg, ".svg");
  for (const size of SIZES) {
    execFileSync("rsvg-convert", [
      join(dir, svg),
      "-w",
      String(size),
      "-h",
      String(size),
      "-o",
      join(out, `${name}-${size}.png`),
    ]);
  }
  console.log(`${name}: ${SIZES.join(", ")}`);
}
