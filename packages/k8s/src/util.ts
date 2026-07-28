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

/**
 * A resources.requests fragment carrying a CPU request derived from a limit,
 * rather than the limit itself.
 *
 * Kubernetes defaults a request to its limit when only the limit is given, so
 * every ceiling in this repo silently became a reservation: blit held two of
 * the node's four CPUs to serve a static page, and the scheduler then refused
 * a VPN transport for "Insufficient cpu" on a box that was almost entirely
 * idle. Requests are what the scheduler subtracts from the node; limits are
 * what a container may burst to. On one node they should not be the same
 * number.
 *
 * A tenth, floored at 10m: enough that relative priority under contention
 * still reflects the limits, small enough that a ceiling costs nothing to
 * declare. Memory is deliberately left alone — it is not compressible, so a
 * request equal to its limit is the safe default there.
 */
export function cpuRequests(limit: string | undefined) {
  if (!limit) return {};
  const millis = limit.endsWith("m")
    ? Number(limit.slice(0, -1))
    : Number(limit) * 1000;
  if (!Number.isFinite(millis)) return {};
  return { requests: { cpu: `${Math.max(10, Math.round(millis / 10))}m` } };
}
