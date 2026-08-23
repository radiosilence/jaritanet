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
