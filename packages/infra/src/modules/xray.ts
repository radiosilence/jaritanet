import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import type * as z from "zod";
import type { XrayConfSchema } from "../conf.schemas.ts";
import type { VpnUser } from "../env.schema.ts";
import { realityKeypair, sha256hex, VPN_ENTRY_LABEL } from "../util.ts";

// A guest may address the public internet and nothing else. Narrower rules were
// a mistake: the exit loopbacks were blocked only on their own port range
// (20000-29999, see deriveExitPort in exit.ts), which left 0.0.0.0 — a synonym
// for localhost on Linux — reachable, and said nothing about the rest of the
// gateway's own stack. Enumerating what a guest may not touch is the losing
// side of that argument, so this is every address that isn't the internet.
export const GUEST_DENY_CIDRS = [
  "100.64.0.0/10", // tailnet
  "fd7a:115c:a1e0::/48",
  "127.0.0.0/8", // the gateway itself, incl. the exit loopbacks
  "0.0.0.0/8",
  "::1/128",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "fc00::/7",
];

/**
 * Xray-core (VLESS-Vision-REALITY), in the cluster on the node it fronts.
 *
 * Behaviourally the same inbound as the systemd unit in xray-systemd.ts — same
 * :443, same guest blackhole, same `dest` handoff — with one deliberate change:
 * the REALITY keypair, the shortId and every client UUID are Pulumi-held rather
 * than minted on the box. That is what makes this a container at all. An on-box
 * key cannot follow a rescheduled pod, and reading it back over SSH is the
 * coupling this whole move exists to remove. The cost is that the private key
 * now lives in Pulumi state as well as on the machine using it (see
 * realityKeypair).
 *
 * `hostNetwork` is required, not incidental. The inbound has to see real client
 * source addresses, it has to own the host's :443, and `dest` is a *loopback*
 * address — 127.0.0.1:8443, which is Traefik's hostPort. Inside a pod netns that
 * would be the pod's own loopback and every non-client TLS handshake would fail.
 *
 * A DaemonSet, not a Deployment: with hostNetwork two replicas can never share a
 * node, so "one per matching node" is the shape, and it makes the port exclusion
 * a property of the primitive rather than something `strategy: Recreate` has to
 * work around.
 *
 * Runs as root with NET_BIND_SERVICE rather than as the image's uid 65532: a
 * capability added to a non-root container lands in the permitted set but not
 * the ambient one, and `allowPrivilegeEscalation: false` closes the file-caps
 * route as well, so a non-root xray cannot bind :443 at all.
 *
 * Nothing here is needed for hardware crypto. `xray version` reports a plain
 * `go1.26.1 linux/amd64` build, and Go picks AES-NI and AVX2 for AES-GCM and
 * ChaCha20 by runtime CPU detection rather than at build time. Those are CPU
 * instructions: no device, no capability, and seccomp filters syscalls, not
 * instructions, so `RuntimeDefault` cannot cost anything here. Written down so
 * nobody later "fixes" throughput by granting privileges it never needed.
 */
export function createXray(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  xray: z.infer<typeof XrayConfSchema>,
  users: VpnUser[],
  dependsOn: pulumi.Resource[] = [],
) {
  const shortId = new random.RandomId("xray-short-id", { byteLength: 8 });

  // 32 bytes of state, from which the x25519 pair is derived on every run.
  // Generating the pair itself would mint a new key each deploy and invalidate
  // every client profile with it.
  const seed = new random.RandomBytes("xray-reality-seed", { length: 32 });
  const keypair = seed.hex.apply((hex) =>
    realityKeypair(Buffer.from(hex, "hex")),
  );

  // One UUID per user, keyed on the (stable) user name so adding or removing a
  // user only churns that user's resource. `email` tags the client for routing.
  const uuids: Record<string, pulumi.Output<string>> = {};
  for (const u of users) {
    uuids[u.name] = new random.RandomUuid(`xray-uuid-${u.name}`).result;
  }

  // Guest hard-block, keyed on the client's `email` (= user name), which is the
  // per-user dimension Xray gives us and hy2 does not. Admins match no guest
  // rule and fall through to `direct`. See xray.ts for why `IPIfNonMatch` is
  // load-bearing: under `AsIs` these IP rules never match a destination given
  // as a domain, and a guest pointing an A record into the tailnet walks past.
  const guests = users.filter((u) => u.role === "guest").map((u) => u.name);

  const config = pulumi
    .all([keypair, shortId.hex, pulumi.all(users.map((u) => uuids[u.name]))])
    .apply(([kp, sid, ids]) =>
      JSON.stringify(
        {
          log: { loglevel: "warning" },
          inbounds: [
            {
              listen: "0.0.0.0",
              port: 443,
              protocol: "vless",
              settings: {
                clients: users.map((u, i) => ({
                  id: ids[i],
                  email: u.name,
                  flow: "xtls-rprx-vision",
                })),
                decryption: "none",
              },
              streamSettings: {
                network: "tcp",
                security: "reality",
                realitySettings: {
                  show: false,
                  dest: xray.dest,
                  xver: 0,
                  serverNames: xray.serverNames,
                  privateKey: kp.privateKey,
                  shortIds: [sid],
                },
              },
              // `user`-scoped routing only resolves once the inbound sniffs the
              // flow. `routeOnly` routes on the sniffed destination without
              // rewriting it.
              sniffing: {
                enabled: true,
                destOverride: ["http", "tls", "quic"],
                routeOnly: true,
              },
            },
          ],
          outbounds: [
            { protocol: "freedom", tag: "direct" },
            { protocol: "blackhole", tag: "block" },
          ],
          routing: {
            domainStrategy: "IPIfNonMatch",
            rules: [
              ...(guests.length
                ? [
                    {
                      user: guests,
                      ip: GUEST_DENY_CIDRS,
                      outboundTag: "block",
                    },
                  ]
                : []),
              // Explicit default, so a non-guest matching no rule proxies out
              // cleanly rather than relying on ordering.
              { network: "tcp,udp", outboundTag: "direct" },
            ],
          },
        },
        null,
        2,
      ),
    );

  const secret = new k8s.core.v1.Secret(
    "xray-config",
    {
      metadata: { name: "xray", namespace },
      stringData: { "config.json": config },
    },
    { provider },
  );

  const app = "xray";
  new k8s.apps.v1.DaemonSet(
    app,
    {
      metadata: { name: app, namespace },
      spec: {
        selector: { matchLabels: { app } },
        // maxUnavailable 1 / maxSurge 0 is the DaemonSet default, set here
        // because it is load-bearing rather than incidental: the old pod must be
        // deleted before the replacement is created, or the new one waits
        // forever on a :443 the old one still holds. Traefik sat 20 days on a
        // stale pod for exactly this reason, silently ignoring chart bumps.
        updateStrategy: {
          type: "RollingUpdate",
          rollingUpdate: { maxUnavailable: 1, maxSurge: 0 },
        },
        template: {
          metadata: {
            labels: { app },
            // A mounted Secret changing does not restart xray, which reads its
            // config once at exec. Without this a rotated UUID would be in the
            // Secret and not in the running process.
            annotations: {
              "jaritanet/config": sha256hex(config).apply((h) =>
                h.slice(0, 16),
              ),
            },
          },
          spec: {
            // See above: real source addresses, the host's :443, and a `dest`
            // that has to mean the host's loopback.
            hostNetwork: true,
            // The host's resolver is unbound on this same box, not the cluster.
            dnsPolicy: "Default",
            automountServiceAccountToken: false,
            // Entries are chosen per node, not per cluster: `lady` joins soon
            // and must not start answering :443 by virtue of being a node.
            nodeSelector: { [VPN_ENTRY_LABEL]: "true" },
            containers: [
              {
                name: app,
                // Tracks `xray.version`, so the pinned core is stated once and
                // the image cannot drift from the version the config targets.
                // The published tags carry no leading `v`.
                image: `ghcr.io/xtls/xray-core:${xray.version.replace(/^v/, "")}`,
                args: ["-config", "/etc/xray/config.json"],
                // A CPU *request* and no CPU limit. A limit is enforced by CFS
                // throttling — once the quota is spent the process is stopped
                // until the next 100ms window, which on a tunnel is periodic
                // latency spikes and stalled transfers rather than a clean
                // slowdown. A request is a scheduler share: it guarantees this a
                // floor when k3s, Traefik and the MCP stack are all busy, and
                // lets it burst into whatever is idle. 200m because REALITY's
                // AES-GCM at this box's uplink is a fraction of a core, but it
                // must never be the thing that loses a scheduling contest.
                //
                // Memory keeps a real limit — it is not compressible, and OOM is
                // better than swapping the whole cluster to death. 512Mi because
                // buffers scale with concurrent streams: rathole, which only
                // shuffles bytes, was OOMKilled at 64Mi and needed 256Mi, and
                // this holds TLS state per connection on top of that.
                resources: {
                  // Re-encrypts every byte it relays, so this is the one
                  // genuinely CPU-bound workload here — ~920Mbit measured
                  // through the tunnel. No CPU limit deliberately: throttling
                  // surfaces as periodic stalls, not a slowdown. The request
                  // is what reserves share when something else bursts.
                  requests: { cpu: "750m" },
                  limits: { memory: "768Mi" },
                },
                volumeMounts: [
                  { name: "config", mountPath: "/etc/xray", readOnly: true },
                ],
                securityContext: {
                  runAsUser: 0,
                  allowPrivilegeEscalation: false,
                  seccompProfile: { type: "RuntimeDefault" },
                  capabilities: {
                    drop: ["ALL"],
                    // :443 is privileged. Nothing else here touches the host.
                    add: ["NET_BIND_SERVICE"],
                  },
                },
              },
            ],
            volumes: [
              { name: "config", secret: { secretName: secret.metadata.name } },
            ],
          },
        },
      },
    },
    { provider, dependsOn },
  );

  return {
    // Not a secret, and a stack output: clients need it to dial the inbound.
    // Without unsecret it inherits the seed's secretness through the derivation.
    publicKey: pulumi.unsecret(keypair.apply((kp) => kp.publicKey)),
    shortId: shortId.hex,
    uuids,
  };
}
