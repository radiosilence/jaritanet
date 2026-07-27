import * as k8s from "@pulumi/kubernetes";

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
export function createUnbound(provider: k8s.Provider, namespace: string) {
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

  return new k8s.apps.v1.Deployment(
    "unbound",
    {
      metadata: { name: "unbound", namespace },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: "unbound" } },
        // Only one process can hold the host's :53, so the old pod has to go
        // before the new one starts. A rolling update would deadlock exactly as
        // Traefik's hostPort did.
        strategy: { type: "Recreate" },
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
            containers: [
              {
                name: "unbound",
                image: "docker.io/klutchell/unbound:v1.24.0",
                args: ["-d", "-c", "/etc/unbound/unbound.conf"],
                resources: { limits: { cpu: "200m", memory: "192Mi" } },
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
    { provider },
  );
}
