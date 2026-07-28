import { join } from "node:path";
import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import { sniLabel } from "./reality.ts";
import type { VpnUser } from "./users.ts";

/**
 * One node in the client profile — the primary gateway or an edge. Credentials
 * are per-user: `reality.uuids[name]` for every user, `hysteria.passwords[name]`
 * for admins only (guests have no hy2 credential). The obfs password is
 * server-wide.
 */
export type SingboxNode = {
  name: string;
  server: pulumi.Input<string>;
  hysteria: {
    altPorts: number[];
    obfsPassword: pulumi.Input<string>;
    passwords: Record<string, pulumi.Input<string>>;
    port: number;
    sni: string;
  };
  reality: {
    publicKey: pulumi.Input<string>;
    serverNames: string[];
    shortId: pulumi.Input<string>;
    uuids: Record<string, pulumi.Input<string>>;
  };
};

/** The same shape with Outputs resolved to plain strings (for JSON.stringify). */
type ResolvedNode = {
  name: string;
  server: string;
  hysteria: {
    altPorts: number[];
    obfsPassword: string;
    passwords: Record<string, string>;
    port: number;
    sni: string;
  };
  reality: {
    publicKey: string;
    serverNames: string[];
    shortId: string;
    uuids: Record<string, string>;
  };
};

/** A selectable egress exit — a Shadowsocks proxy reached via the entry gateway. */
export type Exit = {
  name: string;
  port: number;
  method: string;
  password: pulumi.Input<string>;
};

type ResolvedExit = {
  name: string;
  port: number;
  method: string;
  password: string;
};

// Innermost tun MTU for the whole chain. Sized so a packet survives the worst
// entry path — hy2 (QUIC/UDP) over a reduced-MTU hostile/mobile net (~1400):
// IPv4 20 + UDP 8 + QUIC/AEAD/Salamander ~70 of overhead, so inner ≤ ~1330.
// 1280 (the IPv6 floor, and QUIC's no-fragment floor) sits safely under that
// and never fragments on a roaming link; Reality's TCP MSS clamps to 1240.
// Fragmentation stalls cost far more throughput than 1280's slightly smaller
// packets, so on unknown networks this maximises *real* throughput + latency.
const TUN_MTU = 1280;

// The same server on each of its listening ports — which port survives is a
// property of the client's network, not of the node (see HysteriaConfSchema),
// so every port is an outbound and the urltest finds the one that works. Every
// tag names its own port: in a picker holding several ports and several REALITY
// identities, a bare `hy2-<node>` says nothing about what it actually dials.
const hy2Tag = (n: ResolvedNode, port: number) => `hy2-${n.name}-${port}`;
const hy2 = (n: ResolvedNode, password: string, port: number) => ({
  type: "hysteria2",
  tag: hy2Tag(n, port),
  server: n.server,
  server_port: port,
  password,
  obfs: { type: "salamander", password: n.hysteria.obfsPassword },
  tls: { enabled: true, server_name: n.hysteria.sni, insecure: true },
});
const hy2Ports = (n: ResolvedNode) => [n.hysteria.port, ...n.hysteria.altPorts];
const hy2Tags = (n: ResolvedNode) => hy2Ports(n).map((p) => hy2Tag(n, p));
// One outbound per borrowed identity, all the same inbound: same UUID, key and
// shortId, differing only in the name the ClientHello claims. Which identity
// survives is a property of the network (see XrayConfSchema), so they all sit
// in the urltest and the client settles on one that isn't being intercepted.
// Tagged by identity for the same reason hy2 is tagged by port.
const realityTag = (n: ResolvedNode, sni: string) =>
  `reality-${n.name}-${sniLabel(sni)}`;
const realityTags = (n: ResolvedNode) =>
  n.reality.serverNames.map((sni) => realityTag(n, sni));
const reality = (n: ResolvedNode, uuid: string, sni: string) => ({
  type: "vless",
  tag: realityTag(n, sni),
  server: n.server,
  server_port: 443,
  uuid,
  flow: "xtls-rprx-vision",
  tls: {
    enabled: true,
    server_name: sni,
    utls: { enabled: true, fingerprint: "chrome" },
    reality: {
      enabled: true,
      public_key: n.reality.publicKey,
      short_id: n.reality.shortId,
    },
  },
});
const urltest = (tag: string, outbounds: string[]) => ({
  type: "urltest",
  tag,
  outbounds,
  url: "https://www.gstatic.com/generate_204",
  // 1m across nine candidates was ~540 handshakes an hour, and on cellular
  // each wakeup holds the radio in a high-power RRC state for seconds
  // afterwards, so the modem never reached deep idle. It bought nothing:
  // which entry survives is a property of the *network*, and sing-box
  // re-checks when the default interface changes — i.e. exactly when the
  // answer can have changed. Between those events, re-probing a working path
  // every minute only costs battery.
  interval: "10m",
  // Stop probing a group nobody is routing through. Without it, every
  // per-node group keeps testing forever once a multi-node profile exists.
  idle_timeout: "30m",
  tolerance: 100,
});
const selector = (tag: string, outbounds: string[], def: string) => ({
  type: "selector",
  tag,
  outbounds,
  default: def,
});

/**
 * Builds the sing-box client profile object from resolved node data.
 *
 * We build an object and `JSON.stringify` it rather than templating a JSON
 * string — that can't emit invalid JSON, and the group layout is just data.
 *
 * Two independent axes:
 *   - `entry-select` — which gateway/transport you enter through. Every leaf is
 *     one (node, hy2 port) or (node, REALITY identity) pair, since those are
 *     what a hostile network blocks individually; `auto` urltests the lot and
 *     takes the fastest that answers. Expands with node count: one node →
 *     [auto, leaves]; N → auto-all | per-host groups.
 *   - `exit-select` — where you egress: `entry-select` (direct, at the gateway)
 *     or an `exit-<name>` (a Shadowsocks proxy on that exit, dialled via the
 *     entry gateway). Route `final` points here; tailnet + DNS stay on
 *     `entry-select` so they egress at the gateway, never via an exit.
 *
 * Each exit outbound targets `127.0.0.1:<port>` and detours through the
 * **primary** gateway (the only rathole node) — the inner address resolves at
 * the primary end, hitting that exit's rathole loopback. Exits therefore always
 * transit the primary, regardless of the `entry-select` pick for direct egress.
 *
 * Per-user + role-aware: reality outbounds use the user's own UUID; admins also
 * get hy2 (their per-node password) and the exit axis; guests are
 * reality-only with direct egress (no hy2, no exits) — and their exit/tailnet
 * access is additionally blackholed server-side, so the profile shape is a
 * convenience, not the security boundary.
 */
export function buildProfile(
  user: VpnUser,
  nodes: ResolvedNode[],
  magicdnsSuffix: string,
  exits: ResolvedExit[] = [],
) {
  const isAdmin = user.role === "admin";
  // Guests get no exit axis — the ss PSK is never in their profile anyway.
  const effExits = isAdmin ? exits : [];

  // Transports available to this user per node: reality always; hy2 admin-only.
  const autoTags = (n: ResolvedNode) =>
    isAdmin ? [...hy2Tags(n), ...realityTags(n)] : realityTags(n);
  // Leaf outbounds in picker order — the manual drill-in under a node's group.
  const entryTags = (n: ResolvedNode) =>
    isAdmin ? [...hy2Tags(n), ...realityTags(n)] : realityTags(n);
  const pickTags = (n: ResolvedNode) => [`auto-${n.name}`, ...entryTags(n)];

  const outbounds: Record<string, unknown>[] = [];
  for (const n of nodes) {
    for (const sni of n.reality.serverNames) {
      outbounds.push(reality(n, n.reality.uuids[user.name], sni));
    }
    if (isAdmin) {
      // hy2's server auth is `userpass`, so the client's password must be
      // `<name>:<password>` — the server splits on the first colon to look the
      // user up. Sending the bare password fails auth for every admin.
      const pw = `${user.name}:${n.hysteria.passwords[user.name]}`;
      for (const port of hy2Ports(n)) outbounds.push(hy2(n, pw, port));
    }
  }
  if (nodes.length === 1) {
    const n = nodes[0];
    const candidates = autoTags(n);
    if (candidates.length > 1) {
      outbounds.push(urltest("auto", candidates));
      outbounds.push(
        selector("entry-select", ["auto", ...entryTags(n)], "auto"),
      );
    } else {
      // One candidate, so nothing for a urltest to choose between: a guest on a
      // node serving a single REALITY identity.
      outbounds.push(selector("entry-select", candidates, candidates[0]));
    }
  } else {
    for (const n of nodes) {
      outbounds.push(urltest(`auto-${n.name}`, autoTags(n)));
      outbounds.push(selector(n.name, pickTags(n), `auto-${n.name}`));
    }
    outbounds.push(urltest("auto-all", nodes.flatMap(autoTags)));
    outbounds.push(
      selector(
        "entry-select",
        ["auto-all", ...nodes.map((n) => n.name)],
        "auto-all",
      ),
    );
  }

  // The exit axis only exists when there are exits — otherwise routing points
  // straight at entry-select (direct egress, no extra groups).
  if (effExits.length) {
    // Exits pin to the PRIMARY gateway (nodes[0]) — the only node running
    // rathole, so the only one exposing the exit loopbacks. Edges (also in
    // entry-select) run hy2/reality only; detouring an exit through an edge
    // would dial 127.0.0.1:<port> where nothing listens.
    const ratholeEntry = nodes.length === 1 ? "auto" : `auto-${nodes[0].name}`;

    // Each exit: a Shadowsocks outbound dialled through the primary. The
    // 127.0.0.1:<port> resolves at the primary → its rathole loopback → the
    // exit's ss-rust → egress at the exit's own IP.
    for (const e of effExits) {
      outbounds.push({
        type: "shadowsocks",
        tag: `exit-${e.name}`,
        server: "127.0.0.1",
        server_port: e.port,
        method: e.method,
        password: e.password,
        detour: ratholeEntry,
      });
    }

    // exit-direct = egress at your entry gateway (no exit hop). A thin alias
    // for entry-select so the exit picker reads as egress locations
    // (`exit-direct`, `exit-home`, …) rather than showing "entry-select".
    // Not tagged `direct` — sing-box reserves that for its bypass outbound.
    outbounds.push(selector("exit-direct", ["entry-select"], "entry-select"));
    outbounds.push(
      selector(
        "exit-select",
        ["exit-direct", ...effExits.map((e) => `exit-${e.name}`)],
        "exit-direct",
      ),
    );
  }

  const finalOutbound = effExits.length ? "exit-select" : "entry-select";

  return {
    log: { level: "info", timestamp: true },
    experimental: {
      // Persist the FULL positive DNS cache across restarts (store_dns, 1.14+),
      // so a cold app launch resolves recently-seen names from disk (~0ms) — not
      // just the rejected-response cache that 1.13's store_rdrc managed.
      // REQUIRES a 1.14+ core on EVERY client: store_dns hard-fails ("unknown
      // field") on 1.13.x. Don't merge this to main until the fleet is on 1.14.
      cache_file: { enabled: true, store_dns: true },
    },
    dns: {
      // Every resolver is pinned to entry-select (detour) so DNS egresses at the
      // gateway and NEVER inherits an exit hop, even when exit-select points at
      // an exit. default_domain_resolver (route) is set to match.
      servers: [
        // Primary: the gateway's own unbound cache, reached by dialing
        // 127.0.0.1:53 *at the gateway end* through the tunnel. Prefetch +
        // serve-expired keep the hot set warm, so even a client-cache miss is
        // answered from a Germany-local cache in one tunnel RTT — not a fresh
        // recursion from the client's location.
        {
          type: "udp",
          tag: "gw-cache",
          server: "127.0.0.1",
          detour: "entry-select",
        },
        // Manual-revert fallback: flip `final` to this if the gateway cache is
        // ever unreachable (sing-box does not auto-failover between servers).
        {
          type: "https",
          tag: "cf-doh",
          server: "1.1.1.1",
          detour: "entry-select",
        },
        {
          type: "udp",
          tag: "ts-dns",
          server: "100.100.100.100",
          detour: "entry-select",
        },
      ],
      rules: [{ domain_suffix: [magicdnsSuffix], server: "ts-dns" }],
      final: "gw-cache",
      strategy: "ipv4_only",
      // Optimistic cache (1.14+): serve an expired entry instantly and refresh
      // it in the background, so an expired lookup never blocks on a tunnel RTT.
      // The client-side twin of unbound's serve-expired on the gateway — this is
      // what closes the last gap to "always ~0ms" DNS. 3d stale window.
      optimistic: { enabled: true, timeout: "3d" },
    },
    inbounds: [
      {
        type: "tun",
        tag: "tun-in",
        // Point-to-point tun endpoints. Deliberately NOT in 172.16/12 — that
        // whole range is a collision minefield: Docker bridges live at 172.17/18
        // and, worse, corporate AWS VPCs sit in 172.x. We were on 172.19.0.1/30,
        // which overlaps a work VPC (172.19.0.0/16) whose DNS resolver is at
        // VPC_base+2 = 172.19.0.2 — *exactly* our tun peer, so the tun silently
        // hijacked the VPC resolver whenever both VPNs were up. 198.18.0.0/15 is
        // IANA benchmarking space (RFC 2544): never a real destination, so it
        // can't collide with any VPC, Docker bridge, corp VPN, or home LAN.
        address: ["198.18.0.1/30", "fdfe:dcba:9876::1/126"],
        mtu: TUN_MTU,
        auto_route: true,
        strict_route: true,
        // `mixed` = kernel TCP stack (fast) + gVisor's userspace UDP stack. The
        // gVisor UDP path is LOAD-BEARING, not a perf knob: this client nests a
        // UDP-based corporate VPN (AWS Client VPN = OpenVPN/UDP) inside our
        // tunnel. The kernel `system` stack silently DROPS that nested UDP even
        // with perfect routing (endpoint→sing-box, VPC→AWS tun, all verified) —
        // gVisor reassembles it + does endpoint-independent NAT. Proven the hard
        // way: `system` broke the nested DB path with correct routing; switching
        // to gvisor/mixed fixed it instantly. DO NOT "optimise" back to `system`.
        // `mixed` keeps kernel TCP for everything else; pure `gvisor` also works
        // but costs more CPU.
        stack: "mixed",
      },
    ],
    outbounds,
    route: {
      default_domain_resolver: "gw-cache",
      rules: [
        { action: "sniff" },
        { protocol: "dns", action: "hijack-dns" },
        {
          // Tailnet egresses at the gateway (into the mesh), never via an exit.
          ip_cidr: ["100.64.0.0/10", "fd7a:115c:a1e0::/48"],
          outbound: "entry-select",
        },
      ],
      final: finalOutbound,
      auto_detect_interface: true,
    },
  };
}

/**
 * Tells Telegram where each user's profile now lives.
 *
 * Separate from how the profiles get served because that has changed — the
 * notification is the same either way, and it is the only thing that tells a
 * human their subscription URL moved.
 *
 * `trigger` is a hash of the profile content: an unchanged deploy must stay
 * silent, or the notification becomes noise nobody reads on the deploy that
 * matters.
 */
export function notifyProfileUrls(
  users: { name: string; role: string; url: pulumi.Input<string> }[],
  telegram: { botToken: pulumi.Output<string>; chatId: string },
  trigger: pulumi.Input<string>,
  dependsOn: pulumi.Resource[] = [],
) {
  const payload = pulumi
    .all(users.map((u) => pulumi.output(u.url)))
    .apply((urls) =>
      JSON.stringify(
        users.map((u, i) => ({ name: u.name, role: u.role, url: urls[i] })),
      ),
    );

  // Resolved from this file rather than the Pulumi working directory: the
  // script ships with this package, and a relative path would only ever find it
  // from whichever stack happened to be running.
  const script = join(
    import.meta.dirname,
    "..",
    "scripts",
    "notify-singbox.ts",
  );

  return new command.local.Command(
    "singbox-notify",
    {
      create: `node --experimental-strip-types ${script}`,
      environment: {
        VPN_NOTIFY_USERS: payload,
        TELEGRAM_BOT_TOKEN: telegram.botToken,
        TELEGRAM_CHAT_ID: telegram.chatId,
      },
      triggers: [trigger],
    },
    { dependsOn },
  );
}
