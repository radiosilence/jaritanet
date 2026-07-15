import * as crypto from "node:crypto";
import type * as pulumi from "@pulumi/pulumi";

/**
 * sha256 hex digest of an Output string. Used as a `triggers` value so a
 * command/pod only re-runs when the rendered content it depends on changes.
 */
export const sha256hex = (
  input: pulumi.Output<string>,
): pulumi.Output<string> =>
  input.apply((s) => crypto.createHash("sha256").update(s).digest("hex"));
