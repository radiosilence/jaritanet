import * as crypto from "node:crypto";
import type * as pulumi from "@pulumi/pulumi";

/**
 * The name a REALITY SNI is known by in the client picker: `www.google.co.uk`
 * → `google`. Outbound tags have to be unique, so schemas that accept a list of
 * SNIs reject one whose labels collide rather than emit a broken profile.
 */
export const sniLabel = (sni: string) =>
  sni.replace(/^www\./, "").split(".")[0];

/**
 * sha256 hex digest of an Output string. Used as a `triggers` value so a
 * command/pod only re-runs when the rendered content it depends on changes.
 */
export const sha256hex = (
  input: pulumi.Output<string>,
): pulumi.Output<string> =>
  input.apply((s) => crypto.createHash("sha256").update(s).digest("hex"));
