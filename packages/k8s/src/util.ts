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

const SUFFIXES: Record<string, number> = {
  "": 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
};

/** A Kubernetes memory quantity in bytes, or `undefined` if unparseable. */
function bytes(quantity: string) {
  const m = /^(\d+(?:\.\d+)?)([A-Za-z]*)$/.exec(quantity);
  const multiplier = m && SUFFIXES[m[2] ?? ""];
  return m && multiplier ? Number(m[1]) * multiplier : undefined;
}

/**
 * A resources.requests fragment derived from a container's limits, rather than
 * the limits themselves.
 *
 * Kubernetes defaults a request to its limit when only the limit is given, so
 * every ceiling in this repo silently became a reservation: blit held two of
 * the node's four CPUs to serve a static page, and the scheduler then refused
 * a VPN transport for "Insufficient cpu" on a box that was almost entirely
 * idle. Requests are what the scheduler subtracts from the node; limits are
 * what a container may burst to. On one node they should not be the same
 * number.
 *
 * A twentieth of each, floored at 10m and 32Mi: enough that relative priority
 * under contention still reflects the limits, small enough that a ceiling
 * costs nothing to declare. These workloads are bursty rather than steady —
 * a torrent hashing pieces, a library scan — so the reservation is sized for
 * the idle case the pod is in almost all of the time, not the peak it is
 * allowed to reach.
 *
 * Memory was deliberately excluded from this when it only handled CPU, on the
 * grounds that memory is not compressible and a request equal to its limit is
 * therefore the safe default. That reasoning holds in general and was wrong
 * here: it made every memory ceiling a permanent reservation, and lady reached
 * 94% of its memory requested — navidrome holding 4Gi and mariastew 1Gi —
 * while the pods themselves used single-digit megabytes. Nothing could burst
 * because everything had already claimed what it might one day need.
 *
 * The trade-off being accepted is real. Overcommitting memory means a
 * simultaneous spike is resolved by the OOM killer rather than by the
 * scheduler refusing to place a pod. That ordering is the tolerable one:
 * containers exceeding their request are killed first, so the pod that
 * overreached dies rather than a well-behaved neighbour, and every limit here
 * is a ceiling for a burst that ends — a torrent finishing, a scan
 * completing — not a steady state.
 */
export function resourceRequests(
  limits: { cpu?: string; memory?: string } | undefined,
) {
  if (!limits) return {};
  const requests: { cpu?: string; memory?: string } = {};

  if (limits.cpu) {
    const millis = limits.cpu.endsWith("m")
      ? Number(limits.cpu.slice(0, -1))
      : Number(limits.cpu) * 1000;
    if (Number.isFinite(millis)) {
      requests.cpu = `${Math.max(10, Math.round(millis / 20))}m`;
    }
  }

  if (limits.memory) {
    const total = bytes(limits.memory);
    if (total !== undefined) {
      const mib = Math.max(32, Math.round(total / 20 / 1024 ** 2));
      requests.memory = `${mib}Mi`;
    }
  }

  return Object.keys(requests).length ? { requests } : {};
}
