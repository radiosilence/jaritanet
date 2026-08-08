import { execFileSync } from "node:child_process";
import * as pulumi from "@pulumi/pulumi";

const git = (...args: string[]) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

/**
 * Warns when the deploy is not running from a clean, current `main`.
 *
 * The plan is whatever the checkout contains, so deploying from a branch that
 * is behind reverts everything main has and it lacks — twice that nearly
 * downgraded mariastew, as an incidental line in an unrelated diff. It used to
 * announce itself by accident, as churn on a resource that had the checkout's
 * absolute path in its inputs; that churn is gone (see `notifyProfileUrls`), so
 * the tell is stated outright rather than inferred from a diff that also
 * Telegrammed every VPN user.
 *
 * Skipped under CI, which always deploys the same tree, and silent wherever git
 * cannot answer: a missing upstream ref is not worth a red preview.
 */
export function warnUnlessCleanMain() {
  if (process.env.CI) return;

  const reasons: string[] = [];
  let root: string;
  try {
    root = git("rev-parse", "--show-toplevel");
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    if (branch !== "main") reasons.push(`on ${branch}`);
    if (git("status", "--porcelain")) reasons.push("with uncommitted changes");
  } catch {
    return;
  }

  try {
    const behind = git("rev-list", "--count", "HEAD..origin/main");
    if (behind !== "0") reasons.push(`${behind} commit(s) behind origin/main`);
  } catch {
    // No origin/main to compare against; what was established still holds.
  }

  if (reasons.length) {
    pulumi.log.warn(
      `Deploying from ${root} ${reasons.join(", ")}. The plan is this tree — ` +
        `anything main has that it does not will be reverted.`,
    );
  }
}
