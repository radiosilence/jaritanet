#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * Walks the tracked components, bumps whichever moved, and pushes a commit per
 * component.
 *
 * One pass rather than a job per component: the work is a few seconds of API
 * calls, and a matrix spent minutes booting runners to do it — then had to be
 * serialised anyway, because every entry writes the same file on the same
 * branch.
 *
 * The decisions live in versions.ts, which is where the tests are; this file is
 * the IO around them.
 */
// Every loop below is sequential on purpose. Entries commit to the same branch
// in turn, and the push retry has to see whether the previous attempt worked,
// so the usual "collect into Promise.all" advice would break both.
/* oxlint-disable no-await-in-loop */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { parse, parseDocument } from "yaml";
import {
  applyTemplate,
  decide,
  normaliseVersion,
  parseImageRef,
  readAt,
  STRINGIFY_OPTIONS,
  TrackedListSchema,
  verifyRef,
  writeAt,
} from "./versions.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const TRACKED = join(ROOT, ".github", "tracked-versions.yml");
const CONFIG = join(ROOT, "packages", "infra", "Pulumi.main.yaml");

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(",");

const REGISTRIES: Record<
  string,
  {
    token: (repo: string) => string;
    manifest: (repo: string, tag: string) => string;
  }
> = {
  "ghcr.io": {
    token: (repo) =>
      `https://ghcr.io/token?scope=repository:${repo}:pull&service=ghcr.io`,
    manifest: (repo, tag) => `https://ghcr.io/v2/${repo}/manifests/${tag}`,
  },
  "docker.io": {
    token: (repo) =>
      `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`,
    manifest: (repo, tag) =>
      `https://registry-1.docker.io/v2/${repo}/manifests/${tag}`,
  },
};

const run = promisify(execFile);
const git = (...args: string[]) => run("git", args, { cwd: ROOT });
const log = (message: string) => process.stdout.write(`${message}\n`);
const warn = (message: string) =>
  process.stdout.write(`::warning::${message}\n`);
const env = (name: string) => process.env[name] ?? "";

/**
 * A GitHub release does not prove an image was published. A release job that
 * runs alongside the image build rather than after it will happily tag a
 * release whose build then fails, and pinning to that is an ImagePullBackOff we
 * inflicted on ourselves. So ask the registry.
 */
async function imageExists(ref: string) {
  const { registry, repository, tag } = parseImageRef(ref);
  const endpoints = REGISTRIES[registry];
  if (!endpoints) {
    warn(`no registry client for ${registry}, skipping the existence check`);
    return true;
  }
  const auth = await fetch(endpoints.token(repository));
  if (!auth.ok) return false;
  const { token } = (await auth.json()) as { token?: string };
  if (!token) return false;
  const manifest = await fetch(endpoints.manifest(repository, tag), {
    headers: { authorization: `Bearer ${token}`, accept: MANIFEST_ACCEPT },
  });
  return manifest.status === 200;
}

async function latestTag(repo: string) {
  try {
    const { stdout } = await run("gh", [
      "api",
      `repos/${repo}/releases/latest`,
      "--jq",
      ".tag_name",
    ]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * main can move while this runs — a merged PR, or a long list of releases to
 * fetch. Rebase these commits on top and retry, since it can move again between
 * the rebase and the push.
 */
async function pushWithRebase() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await git("pull", "--rebase", "--autostash");
      await git("push");
      return;
    } catch {
      if (attempt === 3) throw new Error("could not push after 3 attempts");
      log(`push attempt ${attempt} lost a race, retrying`);
      await sleep(attempt * 5000);
    }
  }
}

/**
 * One issue per run, and only when something moved — a job per component meant
 * a separate issue each, which buried the backlog in notifications nobody was
 * meant to action. Closed on creation for the same reason: it is a record that
 * something changed, not work.
 */
async function record(titles: string[], details: string[]) {
  const listed = `Updated ${titles.join(", ")}`;
  const title =
    listed.length > 200 ? `Updated ${titles.length} versions` : listed;
  const { stdout } = await run("gh", [
    "issue",
    "create",
    "--title",
    title,
    "--body",
    `${details.join("\n")}\n[Run](${env("RUN_URL")})`,
  ]);
  const url = stdout.trim();
  try {
    // The app installation can open an issue but is refused when amending one,
    // so closing uses the workflow's own token.
    await run(
      "gh",
      [
        "api",
        "-X",
        "PATCH",
        `repos/${env("GITHUB_REPOSITORY")}/issues/${url.slice(url.lastIndexOf("/") + 1)}`,
        "-f",
        "state=closed",
        "-f",
        "state_reason=completed",
      ],
      { env: { ...process.env, GH_TOKEN: env("ISSUE_TOKEN") } },
    );
  } catch {
    // Best-effort. The updates are already pushed by this point, and a note
    // left open is not worth reporting the run as failed over.
    warn(`opened ${url} but could not close it`);
  }
  log(`recorded at ${url}`);
}

/** Reports what would move without touching the working tree, so the release
 *  and registry checks can be exercised from a laptop. */
const dryRun = process.argv.includes("--dry-run");

const entries = TrackedListSchema.parse(parse(await readFile(TRACKED, "utf8")));
const doc = parseDocument(await readFile(CONFIG, "utf8"));

if (!dryRun) {
  await git("config", "user.email", "action@github.com");
  await git("config", "user.name", "GitHub Action");
  await git("pull", "--rebase", "--autostash");
}

const failed: string[] = [];
const titles: string[] = [];
const details: string[] = [];

for (const entry of entries) {
  const tag = await latestTag(entry.repo);
  if (!tag) {
    warn(`${entry.app} — no readable release on ${entry.repo}`);
    failed.push(entry.app);
    continue;
  }

  const version = normaliseVersion(tag);
  const next = applyTemplate(entry.value, version);
  const ref = verifyRef(entry, version);
  const decision = decide({
    tag,
    current: readAt(doc, entry.path),
    next,
    ref,
    exists: ref ? await imageExists(ref) : true,
  });

  if (decision.kind === "problem") {
    warn(`${entry.app} — ${decision.reason}`);
    failed.push(entry.app);
    continue;
  }
  if (decision.kind === "up-to-date") {
    log(`${entry.app} — up to date (${decision.current})`);
    continue;
  }

  log(`${entry.app} — ${decision.from} -> ${decision.to}`);
  if (!dryRun) {
    writeAt(doc, entry.path, decision.to);
    await writeFile(CONFIG, doc.toString(STRINGIFY_OPTIONS));
    await git("add", CONFIG);
    await git(
      "commit",
      "-q",
      "-m",
      `chore: update ${entry.app} to ${decision.to}`,
    );
  }
  titles.push(`${entry.app} ${version}`);
  details.push(
    `- **${entry.app}** \`${decision.from}\` → \`${decision.to}\` (from ${entry.repo})`,
  );
}

if (titles.length === 0) {
  log("nothing to update");
} else if (dryRun) {
  log(`dry run — ${titles.length} update(s) not written`);
} else {
  await pushWithRebase();
  log(`pushed ${titles.length} update(s)`);
  await record(titles, details);
}

if (failed.length > 0) {
  process.stdout.write(`::error::could not check: ${failed.join(" ")}\n`);
  process.exitCode = 1;
}
