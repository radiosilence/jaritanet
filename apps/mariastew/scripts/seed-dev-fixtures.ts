#!/usr/bin/env -S node --experimental-strip-types
/**
 * Creates adversarial directory names to test layout: CJK brackets, consecutive
 * spaces, www. prefix, square brackets, commas, names >70 chars. Generated with
 * seeded PRNG so "entry #83" is reproducible across runs.
 */
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEV_DATA = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dev-data",
);

const SHAPED_MOVIES = [
  "Nightfall Harbour (2017) (2160p BluRay x265 HEVC 10bit HDR AAC 7.1 Cormorant)",
  "Static.Tide.1994.Criterion.1080p.BluRay.x265.HEVC.10bit.AAC.5.1",
  "Glass Vantage (2014) [1080p]",
  "Hollow Creek Trilogy 1994,2006,2022 1080p BluRay HEVC x265",
  "Ash Field (1996) Criterion (1080p BluRay x265 HEVC 10bit AAC 5.1)",
  "Marrow Ridge (1972) [1080p]",
  "Silver Basin (1992) (1080p BluRay x265 HEVC 10bit AAC 2.0)",
  "Copper Is Mine",
  "Quiet Fault 2010 (1080p Bluray x265 HEVC 10bit AAC 5.1 Cormorant)",
  "Amberline.The.Salt.Saga.2024.2160p.WEB.H265-SaltRush",
  "Ember.Signal.1981.1080p.BluRay.DDP5.1.x265.10bit-Meridian",
  "Rust Drift Inside The Long Dark (2026) 1080p WEBRip x265 PELICAN",
  "Low.Tide.3.Beyond.The.Verge.1985.1080p.BrRip.x264.【WinterFold】",
  "Vantage.North.2019.1080p.BluRay.x264-KESTREL[QTx]",
  "Wake.Of.The.Ember.Line.2000.1080p.BluRay.DDP5.1.x265.MeridianRG265[QTx]",
  "Once Upon a Tide in Harbour (2003) (1080p BluRay x265 HEVC 10bit Cormorant)",
  "The.7th.Crossing.Of.Marrow.1958.Eng.REMASTERED.1080p.BluRay",
  "N for Nightfall (2005) (2160p BluRay x265 HEVC 10bit HDR AAC 7.1 Cormorant)",
  "www.QIndex.test    -    Made In Copper 1982 BluRay 1080p DTS 2 0 AVC REMUX-StoneWork",
  "www.QIndex.test    -    Fault.Line.2026.1080p.TELESYNC.x264-QUARRY",
  "Driftwood (2001) [1080p] [LOFT.AG]",
];

// Divergent spellings hard to tell apart (#257).
const DIVERGENT_SPELLINGS = ["Show Name S02", "Show.Name.Season.2"];

const SHOWS: Record<string, string[]> = {
  "Deadfall Creek": ["Season 01", "Season 02", "Season 03"],
  "Ashfield (2019)": ["Season 01"],
  "The Ember Line": [
    "Season 01",
    "Season 02",
    "Season 03",
    "Season 04",
    "Season 05",
  ],
  Saltmarsh: ["Season 01", "Season 02", "Season 03", "Season 04", "Season 05"],
};

const TARGET_MOVIE_COUNT = 140;

// Seeded PRNG for deterministic filler names.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(0x6d617269); // "mari"

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

const TITLE_WORDS = [
  "Nightfall",
  "Silver",
  "Creek",
  "Harbour",
  "Static",
  "Low",
  "Tide",
  "Glass",
  "Hollow",
  "Vantage",
  "North",
  "Wire",
  "Signal",
  "Ash",
  "Field",
  "Ember",
  "Rust",
  "Salt",
  "Marrow",
  "Drift",
  "Quiet",
  "Ridge",
  "Fault",
  "Line",
  "Verge",
  "Amber",
  "Copper",
  "Basin",
  "Wake",
  "Frost",
];
const RESOLUTIONS = ["1080p", "2160p", "720p"];
const SOURCES = ["BluRay", "WEBRip", "WEB", "BDRip", "DVDRip", "REMUX"];
const CODECS = ["x264", "x265", "HEVC"];
const AUDIO = ["AAC 5.1", "DDP5.1", "AC3", "DTS", "AAC 2.0"];
const GROUPS = [
  "Cormorant",
  "MeridianRG",
  "LOFT.AG",
  "StoneWork",
  "PELICAN",
  "KESTREL",
  "QUARRY",
  "VELD",
  "EMBERS",
  "NTQ",
];

function fillerMovieName(): string {
  const title = `${pick(TITLE_WORDS)} ${pick(TITLE_WORDS)}`;
  const year = 1971 + Math.floor(rand() * 54);
  const res = pick(RESOLUTIONS);
  const source = pick(SOURCES);
  const codec = pick(CODECS);
  const audio = pick(AUDIO);
  const group = pick(GROUPS);
  return `${title} (${year}) ${res} ${source} ${codec} ${audio}-${group}`;
}

function movieNames(): string[] {
  const filler = Array.from(
    { length: Math.max(0, TARGET_MOVIE_COUNT - SHAPED_MOVIES.length) },
    fillerMovieName,
  );
  return [...SHAPED_MOVIES, ...filler];
}

async function seedRoot(root: string, names: string[]) {
  await Promise.all(
    names.map((name) => mkdir(join(DEV_DATA, root, name), { recursive: true })),
  );
}

async function main() {
  if (process.argv.includes("--reset")) {
    await rm(join(DEV_DATA, "movies"), { recursive: true, force: true });
    await rm(join(DEV_DATA, "tv"), { recursive: true, force: true });
  }

  const movies = movieNames();
  await seedRoot("movies", movies);

  const tvDirs = [
    ...Object.entries(SHOWS).flatMap(([show, seasons]) =>
      seasons.map((s) => `${show}/${s}`),
    ),
    ...DIVERGENT_SPELLINGS,
  ];
  await seedRoot("tv", tvDirs);

  const longest = movies.reduce((a, b) => (b.length > a.length ? b : a));
  console.log(
    `movies: ${movies.length} entries, longest ${longest.length} chars`,
  );
  console.log(
    `tv: ${Object.keys(SHOWS).length} shows, ${tvDirs.length} directories total`,
  );
}

await main();
