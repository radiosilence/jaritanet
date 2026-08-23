import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import { VERSIONS } from "./versions.ts";

/**
 * The gateway's caching DNS resolver, as a pod rather than an apt install.
 *
 * Clients do not reach this directly: their sing-box profile points DNS at
 * `127.0.0.1:53` with a detour through the tunnel, so the query arrives at the
 * *gateway's* loopback. That is the whole security model — unbound listens only
 * on loopback and has no public attack surface — and it is why this needs
 * `hostNetwork`. Inside a pod network namespace, `127.0.0.1` would be the pod's
 * own loopback and nothing would ever reach it.
 *
 * Upstream is Cloudflare over DoT, so there is no cleartext DNS anywhere: the
 * client-to-gateway leg is the tunnel, the gateway-to-resolver leg is TLS.
 * Prefetch and serve-expired keep the hot set warm, so a client cache miss is
 * answered from a Germany-local cache in one tunnel RTT rather than a fresh
 * recursion from wherever the client happens to be.
 *
 * Replaces an SSH command that apt-installed unbound and wrote a heredoc — one
 * of five that ran in parallel and fought each other for the dpkg lock.
 */
export function createUnbound(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  entryLabel: string,
  dependsOn: pulumi.Resource[] = [],
) {
  const config = new k8s.core.v1.ConfigMap(
    "unbound-config",
    {
      metadata: { name: "unbound", namespace },
      data: {
        "unbound.conf": `server:
  interface: 127.0.0.1
  port: 53
  do-ip6: no
  access-control: 127.0.0.0/8 allow
  prefetch: yes
  prefetch-key: yes
  serve-expired: yes
  serve-expired-ttl: 86400
  cache-min-ttl: 120
  cache-max-ttl: 86400
  msg-cache-size: 64m
  rrset-cache-size: 128m
  num-threads: 2
  so-reuseport: yes
  qname-minimisation: yes
  hide-identity: yes
  hide-version: yes
  # Running unprivileged in a container, so no setuid away from root and no
  # chroot — the container is the sandbox.
  username: ""
  chroot: ""
  directory: "/etc/unbound"
  logfile: ""
  tls-cert-bundle: "/etc/ssl/certs/ca-certificates.crt"
forward-zone:
  name: "."
  forward-tls-upstream: yes
  forward-addr: 1.1.1.1@853#cloudflare-dns.com
  forward-addr: 1.0.0.1@853#cloudflare-dns.com
`,
      },
    },
    { provider },
  );

  return new k8s.apps.v1.DaemonSet(
    "unbound",
    {
      metadata: { name: "unbound", namespace },
      spec: {
        selector: { matchLabels: { app: "unbound" } },
        // The DaemonSet default, spelled out because it is load-bearing: only
        // one process can hold the host's :53, so the old pod must be deleted
        // before the replacement is created (maxSurge 0). A surging update
        // deadlocks exactly as Traefik's hostPort did.
        updateStrategy: {
          type: "RollingUpdate",
          rollingUpdate: { maxUnavailable: 1, maxSurge: 0 },
        },
        template: {
          metadata: {
            labels: { app: "unbound" },
            annotations: { "jaritanet/config": config.metadata.name },
          },
          spec: {
            // See above: 127.0.0.1 has to mean the *host's* loopback.
            hostNetwork: true,
            // The host's resolver is this pod, so asking the cluster for DNS
            // while providing it would be circular.
            dnsPolicy: "Default",
            automountServiceAccountToken: false,
            // The cache belongs to whichever node terminates tunnels, since
            // that is where 127.0.0.1:53 is dialled from. Same label as the
            // transports, so a node either serves an entry or does not.
            nodeSelector: { [entryLabel]: "true" },
            containers: [
              {
                name: "unbound",
                image: VERSIONS.unbound,
                args: ["-d", "-c", "/etc/unbound/unbound.conf"],
                // 320Mi, not 192Mi: the config above declares 64m of msg cache
                // and 128m of rrset cache, so 192Mi was the cache size exactly,
                // with nothing left for the process holding it. Every client's
                // DNS goes through this, and an OOM here reads as the whole
                // tunnel being broken.
                //
                // A request rather than a CPU limit, as everywhere else here:
                // throttling the resolver adds latency to the first packet of
                // every connection, which is the most visible millisecond in
                // the system. 50m is a floor for work that is mostly a cache
                // hit.
                resources: {
                  requests: { cpu: "50m" },
                  limits: { memory: "320Mi" },
                },
                volumeMounts: [
                  {
                    name: "config",
                    mountPath: "/etc/unbound/unbound.conf",
                    subPath: "unbound.conf",
                    readOnly: true,
                  },
                ],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  seccompProfile: { type: "RuntimeDefault" },
                  capabilities: {
                    drop: ["ALL"],
                    // :53 is privileged, and this is the whole reason a blanket
                    // drop cannot be applied to anything that binds a low port.
                    add: ["NET_BIND_SERVICE"],
                  },
                },
              },
            ],
            volumes: [
              { name: "config", configMap: { name: config.metadata.name } },
            ],
          },
        },
      },
    },
    { provider, dependsOn },
  );
}
