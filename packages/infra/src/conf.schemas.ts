import * as z from "zod";
import { ImageSchema, LimitsSchema } from "./templates/schemas.ts";
import { ServiceArgsSchema } from "./templates/service.schemas.ts";
import { sniLabel } from "./util.ts";

/** One value a backend MCP needs from the user, injected into its own header. */
export const McpCredentialFieldSchema = z.object({
  id: z.string(),
  label: z.string(),
  header: z.string(),
  secret: z.boolean().optional(),
  default: z.string().optional(),
  hint: z.string().optional(),
  required: z.boolean().optional(),
  /** Query whose results become this field's suggestions in the dashboard. */
  optionsQuery: z.string().optional(),
  /** Mutation run after a save, telling the backend what was picked. */
  syncMutation: z.string().optional(),
});

/**
 * An MCP the gateway fronts: one Deployment + Service, and one entry in the
 * registry handed to the gateway. Declared once because the two cannot
 * meaningfully disagree — a registry entry naming a pod that does not exist is
 * a 502 waiting to happen, and the in-cluster URL joining them is derived, not
 * written down.
 *
 * `credentialHeader` is the shorthand for the common one-token case;
 * `fields` covers backends wanting several values (CalDAV needs a username, an
 * app password, and a server URL); `public` covers a backend fronting something
 * public, which needs neither. Exactly one of the three, matching what the
 * gateway's registry accepts.
 *
 * `public` is opt-in rather than inferred from an absent credential block: a
 * backend declaring no credentials is far more often a typo than a decision,
 * and the deploy should fail rather than quietly front an unauthenticated MCP.
 */
export const McpSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    image: z.string(),
    args: z.array(z.string()).default([]),
    port: z.number().default(8080),
    path: z.string().default("/mcp"),
    credentialHeader: z.string().optional(),
    fields: z.array(McpCredentialFieldSchema).optional(),
    /** Takes no credentials at all — see the note above. */
    public: z.boolean().optional(),
    /**
     * Path to a plain GraphQL endpoint the backend serves beside its MCP one,
     * for the dashboard's own lookups. In-cluster only — never proxied.
     */
    graphqlPath: z.string().optional(),
    keyHelpUrl: z.string().optional(),
    keyHint: z.string().optional(),
    /**
     * How to ask this backend whether the stored credentials still work, so the
     * dashboard can distinguish one that is configured from one that is
     * working. Omit it and the gateway claims nothing, which is the honest
     * answer for a backend that authenticates nothing.
     *
     * `path`, `ok` and `rejected` are all optional because backends disagree
     * about how to report bad auth: one that raises needs only a query, one
     * that answers calmly with a status names the values. Nothing is ever
     * reported as rejected unless `rejected` says which value means it — an
     * unreachable server is not evidence about a password.
     */
    verify: z
      .object({
        query: z.string(),
        path: z.string().optional(),
        ok: z.string().optional(),
        rejected: z.string().optional(),
      })
      .optional(),
  })
  .refine(
    (b) =>
      [!!b.credentialHeader, !!b.fields?.length, !!b.public].filter(Boolean)
        .length === 1,
    { message: "set exactly one of credentialHeader, fields, or public" },
  );

/** The MCP Gateway stack (gateway + Hydra + Postgres + the MCPs it fronts). */
export const McpGatewayConfSchema = z.object({
  // Blank in the (public) repo; injected at CI time from secrets, so the source
  // reveals no hostnames. An empty hostname skips the stack (see main.ts).
  hostname: z.string().default(""),
  authHostname: z.string().default(""),
  image: ImageSchema,
  hydraTag: z.string().default("v2.2.0"),
  replicas: z.number().default(2),
  limits: LimitsSchema.default({ cpu: "500m", memory: "256Mi" }),
  // Postgres uses the cluster's default StorageClass unless set — a few tiny
  // tables, so (unlike the media services) we don't pin them to a disk path.
  postgresStorageClass: z.string().optional(),
  mcps: z.array(McpSchema).default([]),
});

export const CloudflareConfSchema = z.object({
  accountId: z.string(),
});

/**
 * Xray-core (VLESS-Vision-REALITY) on the gateway VPS, sharing :443 with
 * rathole. Traffic that doesn't match a client is relayed to `dest`;
 * matched clients are proxied out.
 *
 * `serverNames` are the SNIs the inbound accepts. Ideally an SNI matches the
 * cert served at `dest`, but on a gateway that reverse-proxies its own site the
 * two are deliberately decoupled: `dest` must stay the local backend so real
 * visitors are served, while the SNI has to be a name content filters won't
 * intercept — a sparse own-domain gets mis-rated and the tunnel dies with it.
 *
 * It is a list because no single borrowed identity is safe everywhere, and the
 * ways they fail don't overlap: a category filter forges whatever it rates as
 * adult, while a national firewall blocks the big names outright — Google is
 * camouflage in a British pub and a red flag in China, where Microsoft and
 * Apple still pass. The client gets one outbound per name inside its urltest,
 * so it finds the identity that works on the network it's actually on. First
 * entry is the client's default. Keys, shortIds and `dest` are shared across
 * all of them. Distinct first labels, since those name the client outbounds.
 *
 * `dest` defaults to the local rathole https port; point it at an external
 * "host:port" to use a different backend.
 */
export const XrayConfSchema = z.object({
  dest: z.string().default("127.0.0.1:8443"),
  serverNames: z
    .array(z.string())
    .min(1)
    .refine((names) => new Set(names.map(sniLabel)).size === names.length, {
      message: "serverNames must have distinct first labels",
    }),
  version: z.string().default("v26.3.27"),
});

/**
 * Hysteria2 (QUIC/UDP) on the gateway VPS. Loss-tolerant congestion
 * control keeps it smooth on lossy/jittery links where the TCP-based
 * Reality path melts down; Salamander obfuscation hides the QUIC from DPI.
 * `sni` is cosmetic (clients trust the self-signed cert via insecure).
 *
 * `altPorts` are additional listeners, and the point is that no single UDP
 * port survives every network. Inspecting middleboxes (FortiGate et al) block
 * QUIC on 443 as a matter of course — they cannot deep-inspect it, so they
 * force browsers back to TCP TLS. The alternates are ports a restrictive
 * network has to permit on purpose: 3478 is STUN, open wherever WhatsApp and
 * Teams calls work, and 4500 is IPsec NAT-T, open wherever staff VPNs work.
 * Regimes that block VoIP (Egypt, UAE, Saudi) invert it exactly — 3478 dies
 * first there and 443 lives — which is the argument for serving all of them
 * and letting the client's urltest find the survivor. Keep the list short:
 * each port is another probe on every switch and another row in the picker.
 */
export const HysteriaConfSchema = z.object({
  altPorts: z.array(z.number()).default([3478, 4500]),
  // Not the project's own GHCR org, which publishes nothing: this is the
  // image hysteria's install docs point at, on a maintainer's Docker Hub
  // account. A weaker supply-chain position, accepted knowingly.
  image: z.string().default("docker.io/tobyxdd/hysteria:v2.10.0"),
  port: z.number().default(443),
  sni: z.string().default("www.bing.com"),
});

/**
 * Joins the gateway VPS to the tailnet so it can relay client traffic into
 * the mesh. Clients route 100.64.0.0/10 through the hy2/reality tunnel and
 * the VPS dials those addresses locally over tailscale0 — no IP forwarding
 * or subnet routing, the box just has to be a member. Enabled only when a
 * TS_AUTHKEY is also present. `tag` disables key expiry and drives ACLs;
 * reuse `tag:server` so existing tagOwners/grants apply.
 */
export const TailnetConfSchema = z.object({
  hostname: z.string().default("jaritanet-gw"),
  image: z.string().default("ghcr.io/tailscale/tailscale:v1.98.9"),
  tag: z.string().default("tag:server"),
});

/**
 * A Kubernetes control plane on the gateway itself, so one `pulumi up` creates
 * the box, installs k3s and deploys into it — replacing the ansible → GitHub
 * secrets → workflow round-trip the home cluster needed.
 *
 * `cilium` is not optional in practice: k3s is installed with
 * `--flannel-backend=none` so Cilium can own networking, which means the node
 * stays NotReady until Cilium is deployed. It is also the whole point — flannel
 * has no policy engine, so every NetworkPolicy in this repo is inert under it
 * (see docs/architecture.md).
 *
 * Cilium's version has to match the cluster's: 1.19 supports k8s 1.33–1.36,
 * 1.18 supports 1.30–1.33. Moving `version` without checking that is how you
 * get a cluster with no working network.
 */
export const K3sConfSchema = z.object({
  /**
   * Reach the API server over the tailnet rather than the public IP.
   *
   * The tailnet is the better answer — a control plane with no public listener
   * at all — but it puts an ephemeral CI node's ability to join a mesh on the
   * critical path of every deploy, and that has proven flaky. With this off the
   * kubeconfig points at the public IP and the firewall opens 6443, which is
   * how most managed clusters expose it: TLS with client-cert auth, no
   * anonymous access.
   *
   * The certificate covers whichever is chosen, so verification is real either
   * way — this never falls back to skipping TLS checks.
   */
  apiViaTailnet: z.boolean().default(false),
  ciliumVersion: z.string().default("1.19.6"),
  version: z.string().default("v1.36.2+k3s1"),
});

/**
 * The gateway's caching resolver. Only the image is configurable — everything
 * else about it is determined by the role (loopback only, DoT upstream), and a
 * knob for it would be a way to get it wrong.
 */
export const UnboundConfSchema = z.object({
  image: z.string().default("docker.io/klutchell/unbound:v1.24.0"),
});

export const GatewayConfSchema = z.object({
  hysteria: HysteriaConfSchema.optional(),
  /**
   * What the box is called — in Hetzner, and by default on the tailnet.
   *
   * Separate from the Pulumi resource name, which stays `gateway` so the state
   * mapping survives a rename. The machine can be called whatever it is; the
   * slot it fills is still "the gateway".
   */
  name: z.string().default("sympathy"),
  image: z.string().default("ubuntu-24.04"),
  k3s: K3sConfSchema.optional(),
  location: z.string().default("nbg1"),
  ratholeVersion: z.string().default("v0.5.0"),
  serverType: z.string().default("cx23"),
  tailnet: TailnetConfSchema.optional(),
  unbound: UnboundConfSchema.default({
    image: "docker.io/klutchell/unbound:v1.24.0",
  }),
  xray: XrayConfSchema.optional(),
});

/**
 * A standalone VPN edge box — hy2 + REALITY + tailnet relay, no reverse proxy.
 *
 * Unlike the primary gateway it fronts no home services, which is exactly why
 * its REALITY decoy can point at a real EXTERNAL site: there's no own-site to
 * break by forwarding probe traffic away. `name` drives everything — the
 * `<name>.<zone>` A record clients connect to, the `jaritanet-<name>` tailnet
 * hostname, and the per-instance Pulumi resource names.
 */
export const EdgeConfSchema = z.object({
  hysteria: HysteriaConfSchema.default({
    altPorts: [3478, 4500],
    port: 443,
    sni: "www.bing.com",
    image: "docker.io/tobyxdd/hysteria:v2.10.0",
  }),
  image: z.string().default("ubuntu-24.04"),
  location: z.string().default("hel1"),
  name: z.string(),
  reality: z
    .object({
      dest: z.string().default("www.microsoft.com:443"),
      serverName: z.string().default("www.microsoft.com"),
    })
    .default({
      dest: "www.microsoft.com:443",
      serverName: "www.microsoft.com",
    }),
  serverType: z.string().default("cx23"),
  zone: z.string().default("radiosilence.dev"),
});

/**
 * A selectable egress exit node: rathole client + ss-rust, substrate-agnostic
 * (k8s in the home cluster now; a cloud-init VPS later). Traffic egresses via
 * the exit's own IP.
 *
 * Reached through the EXISTING rathole tunnel, not the tailnet: the exit's
 * ss-rust port is surfaced on the rathole gateway's loopback (`127.0.0.1:<port>`)
 * via a rathole service entry, exactly like the Reality decoy `dest`. The
 * client's ss outbound dials `127.0.0.1:<port>` through that gateway (detour),
 * and because a detour resolves the inner address at the gateway end, it hits
 * the gateway's rathole loopback for this exit.
 *
 * Exits route via the **primary** gateway specifically — it's the only node
 * that runs rathole (edges run hy2/reality only). So the exit detour is pinned
 * to the primary, independent of which entry `entry-select` picks for direct
 * traffic. When more rathole-running gateways exist, `port` must be identical
 * across them so one exit outbound works via any of them.
 *
 * `name` is the only field you normally set — it drives the picker tag
 * (`exit-<name>`) and the resource names. `port` is the gateway loopback port
 * (pure plumbing); leave it unset and it's derived deterministically from the
 * name at deploy time. Only set it to resolve a rare name-hash collision.
 */
export const ExitConfSchema = z.object({
  image: z.string().default("ghcr.io/shadowsocks/ssserver-rust:v1.24.0"),
  method: z.string().default("aes-256-gcm"),
  name: z.string(),
  port: z.number().optional(),
  substrate: z.enum(["k8s"]).default("k8s"),
});

export const TraefikConfSchema = z.object({
  acmeEmail: z.string(),
  chartVersion: z.string().default("41.0.2"),
});

export const ServiceConfSchema = z.object({
  args: ServiceArgsSchema,
  hostname: z.string().optional(),
});

export const ServicesMapSchema = z.record(z.string(), ServiceConfSchema);

const DnsModuleEnum = z.enum(["bluesky", "fastmail"]);

export const ZoneConfSchema = z.object({
  modules: z.array(DnsModuleEnum),
  name: z.string(),
  zoneId: z.string(),
});

export const ZonesConfSchema = z.array(ZoneConfSchema);

export const FastmailConfSchema = z.object({
  dkimDomain: z.string(),
  dkimSubdomain: z.string(),
  dmarcAggEmail: z.string(),
  dmarcPolicy: z.string(),
  dmarcSubdomain: z.string(),
  mxDomain: z.string(),
  spfDomain: z.string(),
});

export const BlueskyConfSchema = z.object({
  did: z.string(),
});

/**
 * Where each user's sing-box profile is served from.
 *
 * Deliberately not on blit.cc: FortiGuard rates it "Other Adult Materials", so
 * a filtered network — exactly the network a VPN profile is wanted on — blocks
 * the device from fetching its own subscription.
 */
export const ProfilesConfSchema = z.object({
  hostname: z.string(),
  image: z.string(),
});

export const ConfSchema = z.object({
  bluesky: BlueskyConfSchema,
  cloudflare: CloudflareConfSchema,
  clusterDomain: z.string().default("cluster.local"),
  edges: z.array(EdgeConfSchema).default([]),
  exits: z.array(ExitConfSchema).default([]),
  externalIp: z.string().optional(),
  fastmail: FastmailConfSchema,
  gateway: GatewayConfSchema.optional(),
  managedBy: z.string().default("jaritanet"),
  mcpGateway: McpGatewayConfSchema.optional(),
  namespace: z.string().default("jaritanet"),
  profiles: ProfilesConfSchema.optional(),
  services: ServicesMapSchema,
  traefik: TraefikConfSchema,
  zones: ZonesConfSchema,
});
