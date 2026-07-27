import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import type * as z from "zod";
import type { XrayConfSchema } from "../conf.schemas.ts";
import type { VpnUser } from "../env.schema.ts";
import { realityKeypair, sha256hex } from "../util.ts";
import { GUEST_DENY_CIDRS } from "./xray.ts";

/**
 * Xray-core (VLESS-Vision-REALITY) as a pod on the gateway's own cluster.
 *
 * Behaviourally the same inbound as the SSH-provisioned unit in xray.ts — same
 * :443, same guest blackhole, same `dest` handoff — with one deliberate change:
 * the REALITY keypair, the shortId and every client UUID are Pulumi-held rather
 * than minted on the box. That is what makes this a pod at all. An on-box key
 * cannot be put in a container that may be rescheduled or rebuilt, and reading
 * it back over SSH is the coupling this whole move exists to remove. The cost is
 * that the private key now lives in Pulumi state as well as on the machine using
 * it (see realityKeypair).
 *
 * `hostNetwork` is required, not incidental. The inbound has to see real client
 * source addresses, it has to own the host's :443, and `dest` is a *loopback*
 * address — 127.0.0.1:8443, which is Traefik's hostPort. Inside a pod netns that
 * would be the pod's own loopback and every non-client TLS handshake would fail.
 *
 * Runs as root with NET_BIND_SERVICE rather than as the image's uid 65532: a
 * capability added to a non-root container lands in the permitted set but not
 * the ambient one, and `allowPrivilegeEscalation: false` closes the file-caps
 * route as well, so a non-root xray cannot bind :443 at all.
 */
export function createXrayPod(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  xray: z.infer<typeof XrayConfSchema>,
  users: VpnUser[],
  dependsOn: pulumi.Resource[] = [],
) {
  const shortId = new random.RandomId("xray-pod-short-id", { byteLength: 8 });

  // 32 bytes of state, from which the x25519 pair is derived on every run.
  // Generating the pair itself would mint a new key each deploy and invalidate
  // every client profile with it.
  const seed = new random.RandomBytes("xray-pod-reality-seed", { length: 32 });
  const keypair = seed.hex.apply((hex) =>
    realityKeypair(Buffer.from(hex, "hex")),
  );

  // One UUID per user, keyed on the (stable) user name so adding or removing a
  // user only churns that user's resource. `email` tags the client for routing.
  const uuids: Record<string, pulumi.Output<string>> = {};
  for (const u of users) {
    uuids[u.name] = new random.RandomUuid(`xray-pod-uuid-${u.name}`).result;
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
  new k8s.apps.v1.Deployment(
    app,
    {
      metadata: { name: app, namespace },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app } },
        // Only one process can hold the host's :443, so the old pod has to go
        // before the new one starts. A rolling update deadlocks — the new pod
        // stays Pending and the old one is never allowed to leave.
        strategy: { type: "Recreate" },
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
            containers: [
              {
                name: app,
                // Tracks `xray.version`, so the pinned core is stated once and
                // the image cannot drift from the version the config targets.
                // The published tags carry no leading `v`.
                image: `ghcr.io/xtls/xray-core:${xray.version.replace(/^v/, "")}`,
                args: ["-config", "/etc/xray/config.json"],
                // No CPU limit: this process is the tunnel, and throttling it
                // presents as a slow VPN rather than as a resource problem.
                resources: { limits: { memory: "256Mi" } },
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
