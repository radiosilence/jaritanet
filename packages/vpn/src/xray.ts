import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import type * as z from "zod";
import type { XrayConfSchema } from "./xray.schemas.ts";
import type { VpnUser } from "./users.ts";
import { sha256hex } from "@jaritanet/k8s";
import { realityKeypair } from "./reality.ts";
import { VERSIONS } from "./versions.ts";

// A guest may address the public internet and nothing else. Narrower rules were
// a mistake: exits were blocked only on their own port range (20000-29999, see
// deriveExitPort in exit.ts), which left 0.0.0.0 — a synonym for localhost on
// Linux — reachable, and said nothing about the rest of the gateway's own
// stack. Enumerating what a guest may not touch is the losing side of that
// argument, so this is every address that isn't the internet. Exits now live at
// tailnet addresses, so the first entry denies them as a consequence rather
// than as a rule of its own.
export const GUEST_DENY_CIDRS = [
  "100.64.0.0/10", // tailnet, incl. every exit
  "fd7a:115c:a1e0::/48",
  "127.0.0.0/8", // the gateway itself
  "0.0.0.0/8",
  "::1/128",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "fc00::/7",
];

/**
 * The private destinations the `direct` freedom outbound may dial, as its
 * `finalRules`.
 *
 * Since Xray 26, freedom blackholes every private and loopback destination
 * (Xray's built-in private list, which includes 127/8, 100.64/10 and fc00::/7)
 * for connections from a vless inbound, unless a `finalRules` entry matches
 * first. The rules run in order and the first match decides; only when none
 * matches does the built-in private block apply, so anything not listed here
 * stays blackholed.
 *
 * The client profile (singbox.ts) needs two of them at the entry: its
 * `gw-cache` resolver, which is unbound on the gateway's own loopback, and the
 * tailnet, which carries MagicDNS (100.100.100.100), every exit and the
 * profile's tailnet route. The tailnet ranges must match that route. Guests
 * reach neither: their routing rule blackholes GUEST_DENY_CIDRS before freedom
 * is chosen.
 */
export const FREEDOM_FINAL_RULES = [
  { action: "allow", network: "tcp,udp", port: "53", ip: ["127.0.0.1/32"] },
  { action: "allow", ip: ["100.64.0.0/10", "fd7a:115c:a1e0::/48"] },
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
  entryLabel: string,
  // Changing this reissues every credential here; see credentialRotation.
  rotation: string,
  dependsOn: pulumi.Resource[] = [],
) {
  const keepers = { rotation };

  const shortId = new random.RandomId("xray-short-id", {
    byteLength: 8,
    keepers,
  });

  // 32 bytes of state, from which the x25519 pair is derived on every run.
  // Generating the pair itself would mint a new key each deploy and invalidate
  // every client profile with it.
  const seed = new random.RandomBytes("xray-reality-seed", {
    length: 32,
    keepers,
  });
  const keypair = seed.hex.apply((hex) =>
    realityKeypair(Buffer.from(hex, "hex")),
  );

  // One UUID per user, keyed on the (stable) user name so adding or removing a
  // user only churns that user's resource. `email` tags the client for routing.
  const uuids: Record<string, pulumi.Output<string>> = {};
  for (const u of users) {
    uuids[u.name] = new random.RandomUuid(`xray-uuid-${u.name}`, {
      keepers,
    }).result;
  }

  // Guest hard-block, keyed on the client's `email` (= user name), which is the
  // per-user dimension Xray gives us and hy2 does not. Admins match no guest
  // rule and fall through to `direct`. See xray.ts for why `IPIfNonMatch` is
  // load-bearing: under `AsIs` these IP rules never match a destination given
  // as a domain, and a guest pointing an A record into the tailnet walks past.
  const guests = users.filter((u) => u.role === "guest").map((u) => u.name);

  // The path is what keeps the XHTTP inbound from answering anyone who finds
  // the CDN hostname, so it lives in state rather than in the repository.
  const xhttpPath = xray.xhttp
    ? new random.RandomString("xray-xhttp-path", {
        length: 24,
        special: false,
        keepers,
      }).result.apply((s) => `/${s}`)
    : undefined;

  const config = pulumi
    .all([
      keypair,
      shortId.hex,
      pulumi.all(users.map((u) => uuids[u.name])),
      xhttpPath ?? "",
    ])
    .apply(([kp, sid, ids, path]) =>
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
                  // PROXY protocol v1 to the relay target, so it sees the real
                  // client rather than this node. Only for our own Traefik on
                  // loopback, which trusts it (@jaritanet/ingress); a decoy
                  // site elsewhere would take the header for garbage.
                  xver: /^(127\.|localhost:|\[::1\]:)/.test(xray.dest) ? 1 : 0,
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
            // Reached only through Traefik, which terminates the CDN's TLS
            // and forwards the secret path here in the clear. All interfaces
            // because Traefik is a pod and dials the node's address, not its
            // loopback; the cloud firewall keeps the port off the internet.
            // No `flow`: Vision needs the raw TLS stream, which XHTTP is not.
            // The same users under the same emails, so the guest rule below
            // applies here as it does to REALITY.
            ...(xray.xhttp
              ? [
                  {
                    listen: "0.0.0.0",
                    port: xray.xhttp.port,
                    protocol: "vless",
                    settings: {
                      clients: users.map((u, i) => ({
                        id: ids[i],
                        email: u.name,
                      })),
                      decryption: "none",
                    },
                    streamSettings: {
                      network: "xhttp",
                      xhttpSettings: { path, mode: "packet-up" },
                    },
                    sniffing: {
                      enabled: true,
                      destOverride: ["http", "tls", "quic"],
                      routeOnly: true,
                    },
                  },
                ]
              : []),
          ],
          outbounds: [
            {
              protocol: "freedom",
              tag: "direct",
              settings: { finalRules: FREEDOM_FINAL_RULES },
            },
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
            nodeSelector: { [entryLabel]: "true" },
            containers: [
              {
                name: app,
                image: VERSIONS.xray,
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
                // better than swapping the whole cluster to death. 1Gi because
                // buffers scale with concurrent streams: rathole, which only
                // shuffles bytes, was OOMKilled at 64Mi, and this holds TLS
                // state per connection on top of that. The request is what it
                // measures with headroom, so the ceiling reserves nothing.
                resources: {
                  // Re-encrypts every byte it relays, so this is the one
                  // genuinely CPU-bound workload here — ~920Mbit measured
                  // through the tunnel. No CPU limit deliberately: throttling
                  // surfaces as periodic stalls, not a slowdown. The request
                  // is what reserves share when something else bursts.
                  requests: { cpu: "750m", memory: "80Mi" },
                  limits: { memory: "1Gi" },
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

  // What Traefik routes the CDN hostname's secret path to. The pod is
  // hostNetwork, so its endpoint is the node's address and the inbound's port.
  // Named `<x>-service` because that is what createIngressRoute dials.
  if (xray.xhttp) {
    new k8s.core.v1.Service(
      "xray-xhttp",
      {
        metadata: { name: "xray-xhttp-service", namespace },
        spec: {
          selector: { app },
          ports: [{ port: 80, targetPort: xray.xhttp.port }],
        },
      },
      { provider },
    );
  }

  return {
    // Not a secret, and a stack output: clients need it to dial the inbound.
    // Without unsecret it inherits the seed's secretness through the derivation.
    publicKey: pulumi.unsecret(keypair.apply((kp) => kp.publicKey)),
    shortId: shortId.hex,
    uuids,
    xhttpPath,
  };
}
