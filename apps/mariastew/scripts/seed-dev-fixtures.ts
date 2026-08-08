#!/usr/bin/env -S node --experimental-strip-types
/**
 * Populates docker-compose's bind-mounted roots (../dev-data/{tv,movies})
 * with directory names shaped like the owner's real library.
 *
 * One empty `downloads` folder cannot reproduce a layout bug — every picker
 * bug found so far only showed up because of what a real name does to the
 * layout: full-width CJK brackets, runs of consecutive spaces, a leading
 * `www.` site prefix, square brackets, commas, names past 70 characters. The
 * real names below are verbatim from that library, not sanitised, and stay
 * present alongside generated filler so the ~140-entry scroll cap is
 * genuinely exercised rather than tested against three tidy names.
 *
 * The filler is deterministic (seeded PRNG, not Math.random()) so a bug
 * report against "entry #83" points at the same name on every machine and
 * every re-run — a fresh random draw each time would make that unreproducible.
 *
 * Only creates directories: this is the same tree the app's own picker reads
 * with tokio::fs::read_dir, so a directory is all a fixture needs to be.
 * mkdir with recursive:true is a no-op on an existing path, which is what
 * makes re-running this safe without deleting anything --reset didn't ask
 * for — including whatever a docker-compose aria2 run has since downloaded
 * into these same directories.
 */
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEV_DATA = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dev-data",
);

// Verbatim from the owner's library — the actual adversarial cases, not a
// paraphrase of them.
const REAL_MOVIES = [
  "Atomic Blonde (2017) (2160p BluRay x265 HEVC 10bit HDR AAC 7.1 Tigole)",
  "Chungking.Express.1994.Criterion.1080p.BluRay.x265.HEVC.10bit.AAC.5.1",
  "Citizenfour (2014) [1080p]",
  "Clerks Trilogy 1994,2006,2022 1080p BluRay HEVC x265",
  "Crash (1996) Criterion (1080p BluRay x265 HEVC 10bit AAC 5.1)",
  "Deliverance (1972) [1080p]",
  "El Mariachi (1992) (1080p BluRay x265 HEVC 10bit AAC 2.0)",
  "England is Mine",
  "Four Lions 2010 (1080p Bluray x265 HEVC 10bit AAC 5.1 Tigole)",
  "Furiosa.A.Mad.Max.Saga.2024.2160p.WEB.H265-FuriousMax",
  "Heavy.Metal.1981.1080p.BluRay.DDP5.1.x265.10bit-Galaxy",
  "Louis Theroux Inside The Manosphere (2026) 1080p WEBRip x265 LAMA",
  "Mad.Max.3.Beyond.Thunderdome.1985.1080p.BrRip.x264.【ThumperDC】",
  "Mystify.Michael.Hutchence.2019.1080p.BluRay.x264-GETiT[TGx]",
  "O.Brother.Where.Art.Thou.2000.1080p.BluRay.DDP5.1.x265.GalaxyRG265[TGx]",
  "Once Upon a Time in Mexico (2003) (1080p BluRay x265 HEVC 10bit Tigole)",
  "The.7th.Voyage.Of.Sinbad.1958.Eng.REMASTERED.1080p.BluRay",
  "V for Vendetta (2005) (2160p BluRay x265 HEVC 10bit HDR AAC 7.1 Tigole)",
  "www.UIndex.org    -    Made In Britain 1982 BluRay 1080p DTS 2 0 AVC REMUX-FraMeSToR",
  "www.UIndex.org    -    Obsession.2026.1080p.TELESYNC.x264-UNiON",
  "Zoolander (2001) [1080p] [YTS.AG]",
];

// Two shows named for the same problem two different ways — #257 exists
// because telling these apart at a glance, on a phone, is genuinely hard.
// Left as leaf directories rather than given Season subfolders: the season
// number is already baked into the name, which is its own real pattern.
const DIVERGENT_SPELLINGS = ["Show Name S02", "Show.Name.Season.2"];

const SHOWS: Record<string, string[]> = {
  Deadwood: ["Season 01", "Season 02", "Season 03"],
  "Chernobyl (2019)": ["Season 01"],
  "The Wire": ["Season 01", "Season 02", "Season 03", "Season 04", "Season 05"],
  Fargo: ["Season 01", "Season 02", "Season 03", "Season 04", "Season 05"],
};

const TARGET_MOVIE_COUNT = 140;

// mulberry32 — small, dependency-free, and seeded so every run generates the
// same filler names in the same order.
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
  "Tigole",
  "GalaxyRG",
  "YTS.AG",
  "FraMeSToR",
  "LAMA",
  "GETiT",
  "RARBG",
  "EVO",
  "SPARKS",
  "NTG",
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
    { length: Math.max(0, TARGET_MOVIE_COUNT - REAL_MOVIES.length) },
    fillerMovieName,
  );
  return [...REAL_MOVIES, ...filler];
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

main();
