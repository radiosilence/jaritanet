/**
 * What jaritanet is.
 *
 * This was `Pulumi.main.yaml` and a Zod parse over it. It is TypeScript now for
 * the reason the services became function calls: `packages/infra` is the
 * instance, not the class, so it can simply say what it runs. The compiler
 * checks the shape, the editor completes it, and a value needed twice is one
 * binding rather than two entries that can drift.
 *
 * The schemas survive as the layer that applies defaults and enforces the
 * invariants a type cannot — that `k3s.version` and `k3s.ciliumVersion` are a
 * tested pair, that no two REALITY server names share a first label. TypeScript
 * describes shapes; those are relationships.
 *
 * Only secrets stayed behind, in `secrets.ts`.
 */
import * as z from "zod";
import {
  AuthConfSchema,
  BlueskyConfSchema,
  CloudflareConfSchema,
  EdgeConfSchema,
  ExitConfSchema,
  FastmailConfSchema,
  GatewayConfSchema,
  TailnetAccountConfSchema,
  TelegramConfSchema,
  TraefikConfSchema,
  ZonesConfSchema,
} from "./schemas.ts";
import { secrets } from "./secrets.ts";

/** Namespace, and the annotation saying what put things in it. */
export const NAMESPACE = "jaritanet";
export const MANAGED_BY = "jaritanet";

/**
 * The node label key marking a machine as a VPN entry.
 *
 * One binding reaches both the command that labels the node and the
 * nodeSelector on every transport DaemonSet, so those cannot disagree. A
 * disagreement schedules zero pods onto a cluster reporting perfectly healthy —
 * the VPN goes dark with nothing anywhere reporting a fault.
 */
export const VPN_ENTRY_LABEL = "jaritanet.radiosilence.dev/vpn-entry";

/**
 * Break-glass admin key, installed on the gateway and every edge over SSH
 * rather than at creation, so rotating it never replaces a box. Not a secret:
 * it is the public half.
 */
export const ADMIN_SSH_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIOKFd98fp579BSC4svd/E8h1Bs5aeu9Iv5qix40+WmI jc@blit.cc";

/**
 * Where each service is published.
 *
 * In the clear. These were encrypted on the grounds that a public repository
 * should not hand out the list, while conceding that every one of them carries
 * a certificate and is therefore in the Certificate Transparency logs already.
 * That distinction rested on the logs being awkward to search, and it has not
 * survived: crt.name will list every name under a domain in one query. The
 * encryption was buying nothing and costing a rule that every doc and comment
 * in the repository had to avoid naming a host.
 *
 * Nothing here was ever a security control. `p.radiosilence.dev` is unguessable
 * by its *path*, which is a generated slug and stays secret; mariastew is a
 * write endpoint onto the media library and is gated by OIDC, not by its
 * address.
 *
 * A name with no entry is built and not published, which is a real state: the
 * samba shares and syncthing's UI are reached on the LAN and the tailnet and
 * have no business having an address.
 */
export const hostnames: Record<string, string> = {
  auth: "auth.blit.cc",
  blit: "blit.cc",
  files: "files.radiosilence.dev",
  mariastew: "dl.blit.cc",
  "mcp-gateway": "mcp.blit.cc",
  metrics: "dash.blit.cc",
  navidrome: "music.blit.cc",
  // Deliberately not on blit.cc: FortiGuard rates it "Other Adult Materials",
  // so a filtered network — exactly the network a VPN profile is wanted on —
  // blocks the device from fetching its own subscription.
  "singbox-profiles": "p.radiosilence.dev",
};

export const cloudflare = CloudflareConfSchema.parse({
  accountId: "365e5168438376dc99d7ee2aedef4624",
  apiToken: secrets.cloudflareApiToken,
});

export const traefik = TraefikConfSchema.parse({ acmeEmail: "jc@blit.cc" });

export const gateway = GatewayConfSchema.parse({
  // sympathy. cx33: 4 vCPU / 8GB, x86 like the box already running, so the last
  // resize was in place — the IP and the on-box REALITY key survived and no
  // client profile had to change. CAX (ARM) was the plan until it turned out to
  // be unavailable in every location.
  name: "sympathy",
  location: "nbg1",
  serverType: "cx33",
  // The cluster lives here: one `pulumi up` creates the box, installs k3s,
  // reads its kubeconfig and deploys into it.
  //
  // Cilium's version must match the k8s minor, and parsing enforces it against
  // CILIUM_K8S_SUPPORT — take a new row from Cilium's own requirements doc for
  // that branch rather than from memory. Outside the tested range you are
  // relying on Kubernetes' backward compatibility rather than on anything
  // tested, and the failure is a cluster that comes up healthy and moves no
  // packets. Both values reach the fleet from here: version via an upgrade
  // Plan, ciliumVersion via Helm.
  k3s: { version: "v1.36.3+k3s1", ciliumVersion: "1.20.0" },
  // xray shares :443; traffic that doesn't match a client falls back to `dest`
  // (Traefik's local https port), so real visitors still get the site.
  //
  // The server names are DELIBERATELY not our own domains. Content-filtering
  // middleboxes decide what to TLS-intercept from the SNI's reputation
  // category, and a sparse personal domain is one bad rating away from having
  // every REALITY handshake forged out from under it — blit.cc is rated "Other
  // Adult Materials" by FortiGuard, which killed the tunnel on every filtered
  // guest network. A category no filter dares touch is worth more here than an
  // SNI matching dest's cert; see docs/architecture.md.
  //
  // A list because no one borrowed identity is safe everywhere: google is
  // camouflage in a British pub and blocked outright in China, where bing and
  // apple still pass. First entry is the client's default; the rest are extra
  // outbounds in its urltest, so it finds the identity the local network
  // tolerates without anyone touching a setting.
  xray: {
    serverNames: [
      "www.google.co.uk",
      "www.microsoft.com",
      "www.apple.com",
      "www.bing.com",
      "www.baidu.com",
      "vk.com",
    ],
    dest: "127.0.0.1:8443",
  },
  // Hysteria2 (QUIC/UDP) on 443/udp — the fast, loss-tolerant daily driver.
  // Empty and present anyway: the key is what deploys it, and everything about
  // it defaults.
  hysteria: {},
  // Joins the VPS to the tailnet so clients can reach 100.x over the tunnel.
  tailnet: { hostname: "sympathy" },
  hcloudToken: secrets.hcloudToken,
});

/** Pure VPN boxes in other locations. None at present. */
export const edges: z.infer<typeof EdgeConfSchema>[] = [];

/**
 * Egress exit nodes — ss-rust on the machine whose IP you want to leave from,
 * selectable in the client as `exit-<name>`. lady is the only one worth having:
 * her address is a consumer ISP's, which no Hetzner range can be.
 *
 * `server` is her tailnet address — how an entry reaches a box behind NAT with
 * no forwarded port. Pinned rather than stable: a re-registration moves it and
 * the exit then dials nobody with everything still reporting healthy, so it is
 * re-read from `kubectl get node lady -o wide` when that happens.
 *
 * `node` is the machine this program marks with `nodeLabel`, over the API
 * rather than SSH. Marking it is the whole deployment: the DaemonSet controller
 * watches Nodes, so the exit appears within a second and vanishes if the label
 * goes. The port is derived from the name; set `port` only to break a clash.
 */
export const exits = z.array(ExitConfSchema).parse([
  {
    name: "lady",
    node: "lady",
    nodeLabel: "jaritanet.radiosilence.dev/vpn-exit",
    server: "100.74.66.121",
  },
]);

const MAIL_MODULES = ["fastmail", "bluesky"] as const;

export const zones = ZonesConfSchema.parse([
  {
    name: "blit.cc",
    zoneId: "8aa9988e3df6b6a6ab4e4e6dbc3a2451",
    modules: MAIL_MODULES,
  },
  {
    name: "radiosilence.dev",
    zoneId: "3373ad7c3dc3104e7aeab31c1176e684",
    modules: MAIL_MODULES,
  },
  {
    name: "buttholes.live",
    zoneId: "1115a1e5006523692d61e49e672f6df0",
    modules: MAIL_MODULES,
  },
]);

export const fastmail = FastmailConfSchema.parse({
  mxDomain: "smtp.messagingengine.com",
  dkimDomain: "dkim.fmhosted.com",
  dkimSubdomain: "_domainkey",
  dmarcSubdomain: "_dmarc",
  dmarcAggEmail: "dmarc-agg@blit.cc",
  dmarcPolicy: "reject",
  spfDomain: "spf.messagingengine.com",
});

export const bluesky = BlueskyConfSchema.parse({
  did: "did:plc:d32vuqlfqjttwbckkxgxgbgl",
});

export const tailnet = TailnetAccountConfSchema.parse({
  authKey: secrets.tailnetAuthKey,
  magicdnsSuffix: "zonkey-jazz.ts.net",
  name: "zonkey-jazz.ts.net",
  oauth: secrets.tailnetOauthClientSecret && {
    clientId: "kwGpaNTK9Y11CNTRL",
    clientSecret: secrets.tailnetOauthClientSecret,
  },
  // Not derivable: Tailscale identities appear nowhere else, and
  // `traefik.acmeEmail` happening to hold the same address is a coincidence.
  tagOwners: ["jc@blit.cc"],
  // Advertised by nodes this stack does not provision. A tag missing from the
  // policy is not cosmetic: a node cannot advertise one it does not define, so
  // it fails to join.
  extraTags: ["tag:ci"],
});

/**
 * Shared account: the sing-box profile server notifies on change, mariastew
 * when a download finishes. Absent → neither sends anything, which both treat
 * as normal rather than as an error.
 */
export const telegram =
  secrets.telegramBotToken && secrets.telegramChatId
    ? TelegramConfSchema.parse({
        botToken: secrets.telegramBotToken,
        chatId: secrets.telegramChatId,
      })
    : undefined;

/**
 * The login screen, at the hostname Hydra already stands at and split from it
 * by path. Beside `traefik` rather than among the services for the same reason:
 * traefik cannot be a service because it is what publishes them, and this
 * cannot because it is what authenticates for them.
 */
export const auth = AuthConfSchema.parse({
  github: {
    clientId: "Ov23lig1BPAzKe4qmT4F",
    clientSecret: secrets.githubClientSecret,
    allowed: "radiosilence",
  },
});
