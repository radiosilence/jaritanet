import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOWS = join(import.meta.dirname, "..", ".github", "workflows");

const workflows = async () => {
  const names = (await readdir(WORKFLOWS)).filter((n) => n.endsWith(".yml"));
  const texts = await Promise.all(
    names.map((n) => readFile(join(WORKFLOWS, n), "utf8")),
  );
  return names.map((name, i) => ({ name, text: texts[i]! }));
};

/**
 * The stack depends on packages published from the app repositories, and
 * GitHub Packages wants a token even for public ones. `.npmrc` names a token
 * file rather than an `${ENV}`, because aube refuses to expand environment
 * variables in auth settings a project controls — so something has to write
 * that file before anything installs.
 *
 * Forgetting it fails at install time with a 401 that reads like a broken
 * registry. It has already happened once: three workflows got the step and
 * `update-apps` did not, so the nightly updater failed on a package it had
 * been installing happily by hand.
 */
describe("every workflow that installs can authenticate", () => {
  it("writes the token file before installing", async () => {
    for (const { name, text } of await workflows()) {
      if (!text.includes("aube-action")) continue;
      expect(
        text.indexOf("mise run auth"),
        `${name} authenticates`,
      ).toBeGreaterThan(-1);
      expect(
        text.indexOf("mise run auth"),
        `${name} authenticates before it installs`,
      ).toBeLessThan(text.indexOf("aube-action"));
    }
  });

  it("grants itself read access to the packages", async () => {
    for (const { name, text } of await workflows()) {
      if (!text.includes("aube-action")) continue;
      expect(text, `${name} has packages: read`).toContain("packages: read");
    }
  });
});

/**
 * A dependency bump is two files. Every workflow installs with
 * `--frozen-lockfile`, which refuses a manifest the lockfile disagrees with, so
 * a commit carrying only `package.json` is a red deploy rather than a version
 * that quietly did not take. It has happened once: the updater moved
 * `@radiosilence/mcp-gateway-pulumi` to 0.8.4 and left the lockfile on 0.8.3.
 */
describe("the lockfile agrees with every manifest", () => {
  it("resolves each workspace dependency at the version its manifest asks for", async () => {
    const root = join(import.meta.dirname, "..");
    const lock = await readFile(join(root, "aube-lock.yaml"), "utf8");
    const manifests = ["packages/infra/package.json"];
    for (const m of manifests) {
      const { dependencies } = JSON.parse(
        await readFile(join(root, m), "utf8"),
      );
      for (const [name, spec] of Object.entries(dependencies ?? {})) {
        // Exact pins only. A range resolves to something the lockfile records
        // and the manifest does not, so there is no string to compare — and
        // the updater only ever writes exact versions anyway.
        if (typeof spec !== "string" || !/^\d+\.\d+\.\d+/.test(spec)) continue;
        expect(lock, `${m}: ${name}@${spec} is in the lockfile`).toContain(
          `${name}@${spec}`,
        );
      }
    }
  });
});
