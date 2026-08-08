import { cpuRequests } from "@jaritanet/k8s";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type * as z from "zod";
import type { MariastewConfSchema } from "./mariastew.schemas.ts";

const SECRETS_NAME = "mariastew-secrets";
/** An env `valueFrom` pointing at a key in this service's Secret. */
const secretRef = (key: string) => ({
  valueFrom: { secretKeyRef: { name: SECRETS_NAME, key } },
});

/**
 * Places the peer-port forward on the router, then keeps replacing it.
 *
 * `miniupnpc` is installed at start rather than baked into an image of our
 * own: it is one binary invoked in a loop, and a container built and released
 * here would need a version, a workflow and a tracked-versions entry to carry
 * it. If the mirror is unreachable the pod crash-loops and retries, which is
 * the same outcome as a missing mapping — outbound-only.
 */
const PORTMAP = `set -eu
apk add --no-cache miniupnpc >/dev/null

# Asked of the routing table rather than configured. This pod follows a label
# to whichever machine is the file node, and that machine's address comes from
# DHCP, so neither is a thing to write down.
lan() { ip -4 route get 1.1.1.1 | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}'; }

while :; do
  ip=$(lan)
  for proto in TCP UDP; do
    if upnpc -e aria2 -a "$ip" "$PORT" "$PORT" "$proto" "$LEASE" >/dev/null 2>&1; then
      echo "mapped $proto $PORT -> $ip:$PORT for $LEASE""s"
    else
      echo "WARNING: could not map $proto $PORT — aria2 stays outbound-only"
    fi
  done
  # Half the lease, so a refusal has a full cycle to recover in before the
  # router drops the mapping.
  sleep $((LEASE / 2))
done`;

/**
 * mariastew: a torrent web UI, and the aria2 it fronts.
 *
 * One pod, two containers, one image. aria2c and the service ship together, so
 * there is one pin, one release and one supply chain to vet, and the pod simply
 * runs the image twice.
 *
 * A bespoke module rather than the generic `createService` template because
 * that template builds one container, and the sidecar is the whole design: the
 * two share the pod's network namespace, which is what puts aria2's RPC on a
 * loopback nothing outside the pod can reach. That is why aria2 needs no secret
 * of its own — and why this service is the only gate in front of it.
 */
export function createMariastew(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  conf: z.infer<typeof MariastewConfSchema>,
  opts: {
    nodeLabel: string;
    /**
     * Issued by the identity provider, which registers this client with Hydra
     * on its own behalf. Handed over rather than generated here: a service
     * minting its own credential and registering itself is the thing that made
     * every relying party need to know how identity works.
     */
    oidcClientSecret: pulumi.Input<string>;
    telegram?: { botToken: pulumi.Input<string>; chatId: pulumi.Input<string> };
  },
) {
  const options = { provider };
  const oidc = conf.oidc;
  if (!oidc) {
    throw new Error("createMariastew needs `oidc`: see the caller's guard");
  }

  const clientSecret = pulumi.output(opts.oidcClientSecret);

  const secret = new k8s.core.v1.Secret(
    "mariastew-secrets",
    {
      metadata: { name: SECRETS_NAME, namespace },
      stringData: {
        "oidc-client-secret": clientSecret,
        ...(opts.telegram && {
          "telegram-bot-token": pulumi.output(opts.telegram.botToken),
          "telegram-chat-id": pulumi.output(opts.telegram.chatId),
        }),
      },
    },
    options,
  );

  const image = `${conf.image.repository}:${conf.image.tag}`;
  const mounts = conf.roots.map(({ name, hostPath }) => ({
    name,
    mountPath: hostPath,
  }));

  new k8s.apps.v1.Deployment(
    "mariastew",
    {
      metadata: { name: "mariastew", namespace },
      spec: {
        replicas: 1,
        // One pod holding hostPath mounts on one node: a surge would put the
        // incoming pod on the same directories as the one it replaces.
        strategy: { type: "Recreate" },
        selector: { matchLabels: { app: "mariastew" } },
        template: {
          metadata: { labels: { app: "mariastew" } },
          spec: {
            automountServiceAccountToken: false,
            /**
             * Public resolvers rather than the cluster's.
             *
             * Every name this resolves is a public one — Hydra at its own
             * hostname, Telegram, and a tracker — and the NetworkPolicy below
             * forbids reaching anything inside the cluster at all, so the
             * cluster resolver could only ever answer names this is not allowed
             * to talk to. Depending on it would be borrowing a failure domain
             * for nothing.
             *
             * Two resolvers from different operators, because a torrent client
             * that cannot resolve is a torrent client that does nothing.
             */
            dnsPolicy: "None",
            dnsConfig: {
              nameservers: ["1.1.1.1", "9.9.9.9"],
              options: [
                { name: "timeout", value: "2" },
                { name: "attempts", value: "3" },
              ],
            },
            // Where the disks are. Which machine that is stays a property of
            // the machine, applied by the seed drive when it joins.
            nodeSelector: { [opts.nodeLabel]: "true" },
            // The media tree is 1000:1000 throughout and samba serves it as
            // that user, so a container writing as root produces files the
            // shares can read but not manage. navidrome already carries a
            // `fix-ownership` init container because of this; a second one
            // would be a second mistake rather than a pattern.
            //
            // `fsGroup` is deliberately absent — it switches on kubelet volume
            // ownership management, which would walk and chown the media tree.
            securityContext: { runAsUser: 1000, runAsGroup: 1000 },
            // NOT hostNetwork. The two containers share the pod's network
            // namespace, which is exactly what makes aria2's RPC reachable at
            // 127.0.0.1 by this service and by nothing else.
            containers: [
              {
                name: "mariastew",
                image,
                imagePullPolicy: conf.image.pullPolicy ?? "Always",
                ports: [{ name: "http", containerPort: 8080 }],
                env: [
                  { name: "BIND_ADDR", value: "0.0.0.0:8080" },
                  {
                    name: "ARIA2_RPC_URL",
                    value: "http://127.0.0.1:6800/jsonrpc",
                  },
                  {
                    name: "ROOTS",
                    value: conf.roots
                      .map((r) => `${r.name}:${r.hostPath}`)
                      .join(","),
                  },
                  { name: "PUBLIC_URL", value: `https://${conf.hostname}` },
                  { name: "OIDC_ISSUER", value: oidc.issuer },
                  { name: "OIDC_CLIENT_ID", value: oidc.clientId },
                  {
                    name: "OIDC_CLIENT_SECRET",
                    ...secretRef("oidc-client-secret"),
                  },
                  ...(opts.telegram
                    ? [
                        {
                          name: "TELEGRAM_BOT_TOKEN",
                          ...secretRef("telegram-bot-token"),
                        },
                        {
                          name: "TELEGRAM_CHAT_ID",
                          ...secretRef("telegram-chat-id"),
                        },
                      ]
                    : []),
                ],
                readinessProbe: {
                  httpGet: { path: "/healthz", port: 8080 },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
                resources: {
                  limits: conf.limits,
                  ...cpuRequests(conf.limits.cpu),
                },
                securityContext: { allowPrivilegeEscalation: false },
                volumeMounts: mounts,
              },
              {
                name: "aria2",
                image,
                imagePullPolicy: conf.image.pullPolicy ?? "Always",
                command: [
                  "/usr/bin/aria2c",
                  "--enable-rpc",
                  "--rpc-listen-all=false",
                  "--rpc-listen-port=6800",
                  `--dir=${conf.roots[0]?.hostPath}`,
                  "--continue=true",
                  "--check-integrity=true",
                  // Nothing is preallocated, so a file the metadata pass chose
                  // not to download never appears on disk at all — which is
                  // what makes downloading straight into the library safe.
                  "--file-allocation=none",
                  `--seed-ratio=${conf.aria2.seedRatio}`,
                  `--max-concurrent-downloads=${conf.aria2.maxConcurrentDownloads}`,
                  `--max-connection-per-server=${conf.aria2.maxConnectionPerServer}`,
                  `--max-overall-download-limit=${conf.aria2.maxOverallDownloadLimit}`,
                  `--max-overall-upload-limit=${conf.aria2.maxOverallUploadLimit}`,
                  `--bt-max-peers=${conf.aria2.btMaxPeers}`,
                  `--bt-request-peer-speed-limit=${conf.aria2.peerSpeedLimit}`,
                  // One number for both, so a single forwarded port covers
                  // peers and the DHT rather than needing two.
                  `--listen-port=${conf.aria2.listenPort}`,
                  `--dht-listen-port=${conf.aria2.listenPort}`,
                  "--enable-dht=true",
                  "--bt-enable-lpd=true",
                  "--enable-peer-exchange=true",
                ],
                // `hostPort` publishes the peer port on the node it runs on,
                // which is what any forward has to aim at — without it the
                // port exists only inside the pod network and nothing
                // upstream can be pointed anywhere useful.
                ports: [
                  {
                    name: "bt-tcp",
                    protocol: "TCP",
                    containerPort: conf.aria2.listenPort,
                    hostPort: conf.aria2.listenPort,
                  },
                  {
                    name: "bt-udp",
                    protocol: "UDP",
                    containerPort: conf.aria2.listenPort,
                    hostPort: conf.aria2.listenPort,
                  },
                ],
                securityContext: { allowPrivilegeEscalation: false },
                volumeMounts: mounts,
              },
            ],
            // `Directory` rather than `DirectoryOrCreate`: an unmounted media
            // drive leaves the pod Pending instead of serving and writing into
            // an empty mountpoint on the root filesystem.
            volumes: conf.roots.map(({ name, hostPath }) => ({
              name,
              hostPath: { path: hostPath, type: "Directory" },
            })),
          },
        },
      },
    },
    // The pod reads its OIDC credential out of that Secret by reference, which
    // Pulumi cannot see, so the ordering is stated.
    { dependsOn: [secret], deleteBeforeReplace: true, provider },
  );

  /**
   * Keeps a UPnP forward for the peer port alive on the house router.
   *
   * Its own pod, not a container beside aria2, and the reason is the
   * NetworkPolicy below. UPnP discovery is an SSDP multicast to
   * 239.255.255.250, which the pod network does not carry — the mapper has to
   * be on the LAN, which means `hostNetwork`, which means leaving the policy's
   * reach. Putting it in the mariastew pod would take the pod that writes to
   * the media library and terminates traffic from the internet out of its
   * confinement to buy a port mapping. This pod reads nothing, mounts nothing
   * and holds no credential, so being unconfined costs nothing.
   *
   * Mappings carry a lease and the router drops them on reboot, so this
   * re-places rather than sets-and-forgets. A failure is logged and retried at
   * the next tick: an expired mapping means outbound-only, which is where
   * everything was before this existed.
   */
  if (conf.aria2.upnp) {
    const lease = 3600;
    new k8s.apps.v1.Deployment(
      "mariastew-portmap",
      {
        metadata: { name: "mariastew-portmap", namespace },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: "mariastew-portmap" } },
          template: {
            metadata: { labels: { app: "mariastew-portmap" } },
            spec: {
              automountServiceAccountToken: false,
              hostNetwork: true,
              // The router is an address, not a name, so this resolves only
              // its own package mirror. Public resolvers for the same reason
              // as the deployment above — no reason to borrow the cluster's
              // failure domain for it.
              dnsPolicy: "None",
              dnsConfig: { nameservers: ["1.1.1.1", "9.9.9.9"] },
              // Follows the file node, because the mapping has to point at
              // whichever machine is actually running aria2.
              nodeSelector: { [opts.nodeLabel]: "true" },
              containers: [
                {
                  name: "portmap",
                  image: "alpine:3.21",
                  command: ["sh", "-c", PORTMAP],
                  env: [
                    { name: "PORT", value: String(conf.aria2.listenPort) },
                    { name: "LEASE", value: String(lease) },
                  ],
                  securityContext: { allowPrivilegeEscalation: false },
                  resources: {
                    requests: { cpu: "5m", memory: "16Mi" },
                    limits: { memory: "32Mi" },
                  },
                },
              ],
            },
          },
        },
      },
      { provider },
    );
  }

  // Named for what `createIngressRoute` derives from the route prefix.
  const service = new k8s.core.v1.Service(
    "mariastew-service",
    {
      metadata: { name: "mariastew-service", namespace },
      spec: {
        selector: { app: "mariastew" },
        ports: [{ port: 80, targetPort: 8080 }],
      },
    },
    options,
  );

  // Egress only. This holds write access to the media library and terminates
  // traffic from the internet, and it needs nothing inside the cluster at all —
  // peers, Hydra and Telegram are all reached at public addresses. So confining
  // it to "the internet, which it can already reach" costs nothing and takes
  // the lateral step away from a bug in it.
  //
  // No ingress rule: Traefik reaches it, and an ingress policy that also drops
  // the kubelet's probes gets the pod killed for failing readiness.
  //
  // DNS needs its own rule because the cluster resolver's ClusterIP sits inside
  // the private space the second rule excludes; rules are OR'd, so the narrow
  // allow survives the broad deny.
  new k8s.networking.v1.NetworkPolicy(
    "mariastew-netpol",
    {
      metadata: { name: "mariastew", namespace },
      spec: {
        podSelector: { matchLabels: { app: "mariastew" } },
        policyTypes: ["Egress"],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                },
              },
            ],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
          {
            to: [
              {
                ipBlock: {
                  cidr: "0.0.0.0/0",
                  except: [
                    "10.0.0.0/8",
                    "172.16.0.0/12",
                    "192.168.0.0/16",
                    "169.254.0.0/16",
                    "100.64.0.0/10",
                  ],
                },
              },
            ],
          },
        ],
      },
    },
    options,
  );

  return service;
}
