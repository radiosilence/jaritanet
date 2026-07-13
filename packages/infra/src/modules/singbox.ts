import * as crypto from "node:crypto";
import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";

/** One node in the client profile — the primary gateway or an edge. */
export type SingboxNode = {
  name: string;
  server: pulumi.Input<string>;
  hysteria: {
    authPassword: pulumi.Input<string>;
    obfsPassword: pulumi.Input<string>;
    port: number;
    sni: string;
  };
  reality: {
    publicKey: pulumi.Input<string>;
    serverName: string;
    shortId: pulumi.Input<string>;
    uuid: pulumi.Input<string>;
  };
};

/** The same shape with Outputs resolved to plain strings (for JSON.stringify). */
type ResolvedNode = {
  name: string;
  server: string;
  hysteria: {
    authPassword: string;
    obfsPassword: string;
    port: number;
    sni: string;
  };
  reality: {
    publicKey: string;
    serverName: string;
    shortId: string;
    uuid: string;
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

// Brutal is opt-in, not the default. Setting bandwidth switches Hysteria2 from
// adaptive BBR to the Brutal congestion control, which paces to a fixed rate and
// ignores loss — it stomps through lossy/censored *fat* links where BBR backs
// off, but on a genuinely slow or metered link (mid-tier LTE, hotel wifi) it
// blasts loss into a small pipe and feels *worse*. So the daily driver (`hy2-*`,
// and `auto`) stays adaptive and safe on every link; a separate `hy2b-*` variant
// carries these bandwidth hints and lives in the selector for manual use when
// you know you're on a fat hostile pipe. Tune to your actual line.
// (Reality has no such knob — it stays adaptive TCP; its speed comes from MTU.)
const HY2_UP_MBPS = 1000;
const HY2_DOWN_MBPS = 1000;

// Innermost tun MTU for the whole chain. Sized so a packet survives the worst
// entry path — hy2 (QUIC/UDP) over a reduced-MTU hostile/mobile net (~1400):
// IPv4 20 + UDP 8 + QUIC/AEAD/Salamander ~70 of overhead, so inner ≤ ~1330.
// 1280 (the IPv6 floor, and QUIC's no-fragment floor) sits safely under that
// and never fragments on a roaming link; Reality's TCP MSS clamps to 1240.
// Fragmentation stalls cost far more throughput than 1280's slightly smaller
// packets, so on unknown networks this maximises *real* throughput + latency.
const TUN_MTU = 1280;

const hy2 = (n: ResolvedNode) => ({
  type: "hysteria2",
  tag: `hy2-${n.name}`,
  server: n.server,
  server_port: n.hysteria.port,
  password: n.hysteria.authPassword,
  obfs: { type: "salamander", password: n.hysteria.obfsPassword },
  tls: { enabled: true, server_name: n.hysteria.sni, insecure: true },
});
// Same endpoint, but with bandwidth hints → Brutal. Manual-pick only.
const hy2Brutal = (n: ResolvedNode) => ({
  ...hy2(n),
  tag: `hy2b-${n.name}`,
  up_mbps: HY2_UP_MBPS,
  down_mbps: HY2_DOWN_MBPS,
});
const reality = (n: ResolvedNode) => ({
  type: "vless",
  tag: `reality-${n.name}`,
  server: n.server,
  server_port: 443,
  uuid: n.reality.uuid,
  flow: "xtls-rprx-vision",
  tls: {
    enabled: true,
    server_name: n.reality.serverName,
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
  interval: "1m",
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
 *   - `entry-select` — which gateway/transport you enter through. Expands with
 *     node count: one node → [auto, hy2, reality]; N → auto-all | per-host.
 *   - `exit-select` — where you egress: `entry-select` (direct, at the gateway)
 *     or an `exit-<name>` (a Shadowsocks proxy on that exit, dialled via the
 *     entry gateway). Route `final` points here; tailnet + DNS stay on
 *     `entry-select` so they egress at the gateway, never via an exit.
 *
 * Each exit outbound targets `127.0.0.1:<port>` and detours through the
 * **primary** gateway (the only rathole node) — the inner address resolves at
 * the primary end, hitting that exit's rathole loopback. Exits therefore always
 * transit the primary, regardless of the `entry-select` pick for direct egress.
 */
export function buildProfile(
  nodes: ResolvedNode[],
  magicdnsSuffix: string,
  exits: ResolvedExit[] = [],
) {
  const outbounds: Record<string, unknown>[] = [];
  for (const n of nodes) {
    outbounds.push(hy2(n), reality(n), hy2Brutal(n));
  }
  if (nodes.length === 1) {
    const t = nodes[0].name;
    outbounds.push(urltest("auto", [`hy2-${t}`, `reality-${t}`]));
    outbounds.push(
      selector(
        "entry-select",
        ["auto", `hy2-${t}`, `hy2b-${t}`, `reality-${t}`],
        "auto",
      ),
    );
  } else {
    for (const n of nodes) {
      outbounds.push(
        urltest(`auto-${n.name}`, [`hy2-${n.name}`, `reality-${n.name}`]),
      );
      outbounds.push(
        selector(
          n.name,
          [
            `auto-${n.name}`,
            `hy2-${n.name}`,
            `hy2b-${n.name}`,
            `reality-${n.name}`,
          ],
          `auto-${n.name}`,
        ),
      );
    }
    outbounds.push(
      urltest(
        "auto-all",
        nodes.flatMap((n) => [`hy2-${n.name}`, `reality-${n.name}`]),
      ),
    );
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
  if (exits.length) {
    // Exits pin to the PRIMARY gateway (nodes[0]) — the only node running
    // rathole, so the only one exposing the exit loopbacks. Edges (also in
    // entry-select) run hy2/reality only; detouring an exit through an edge
    // would dial 127.0.0.1:<port> where nothing listens.
    const ratholeEntry = nodes.length === 1 ? "auto" : `auto-${nodes[0].name}`;

    // Each exit: a Shadowsocks outbound dialled through the primary. The
    // 127.0.0.1:<port> resolves at the primary → its rathole loopback → the
    // exit's ss-rust → egress at the exit's own IP.
    for (const e of exits) {
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
        ["exit-direct", ...exits.map((e) => `exit-${e.name}`)],
        "exit-direct",
      ),
    );
  }

  const finalOutbound = exits.length ? "exit-select" : "entry-select";

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

type DeliveryOpts = {
  slug: string;
  filesHostname: string;
  magicdnsSuffix: string;
  oldboy: { host: string; user: string; privateKey: pulumi.Output<string> };
  telegram?: { botToken: pulumi.Output<string>; chatId: string };
  exits?: Exit[];
};

/**
 * Generates the profile and delivers it to the file server, replacing the old
 * ansible role. The `sha256(profile)` trigger is the change-detection: the
 * write only re-runs when the rendered profile actually changes, and the
 * Telegram notify (a local command that draws the QR) fires on the same
 * trigger — so an unchanged deploy is silent. The profile rides `stdin`, never
 * the command string, so credentials stay out of process args and state.
 */
export function createSingboxDelivery(
  nodes: SingboxNode[],
  opts: DeliveryOpts,
) {
  const profileJson = pulumi
    .all([pulumi.output(nodes), pulumi.output(opts.exits ?? [])])
    .apply(([resolvedNodes, resolvedExits]) =>
      JSON.stringify(
        buildProfile(
          resolvedNodes as ResolvedNode[],
          opts.magicdnsSuffix,
          resolvedExits as ResolvedExit[],
        ),
        null,
        2,
      ),
    );
  const profileHash = profileJson.apply((s) =>
    crypto.createHash("sha256").update(s).digest("hex"),
  );

  const destDir = "/srv/files/.sfm";
  const dest = `${destDir}/${opts.slug}.json`;

  const write = new command.remote.Command("singbox-profile", {
    connection: {
      host: opts.oldboy.host,
      user: opts.oldboy.user,
      privateKey: opts.oldboy.privateKey,
    },
    create: `mkdir -p ${destDir} && cat > ${dest} && chmod 644 ${dest}`,
    stdin: profileJson,
    triggers: [profileHash],
  });

  if (opts.telegram) {
    const url = `https://${opts.filesHostname}/.sfm/${opts.slug}.json`;
    new command.local.Command(
      "singbox-notify",
      {
        create: "node --experimental-strip-types scripts/notify-singbox.ts",
        environment: {
          SINGBOX_URL: url,
          TELEGRAM_BOT_TOKEN: opts.telegram.botToken,
          TELEGRAM_CHAT_ID: opts.telegram.chatId,
        },
        triggers: [profileHash],
      },
      { dependsOn: [write] },
    );
  }

  return { profileHash, profileJson };
}
