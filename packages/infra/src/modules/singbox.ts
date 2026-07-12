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

const hy2 = (n: ResolvedNode) => ({
  type: "hysteria2",
  tag: `hy2-${n.name}`,
  server: n.server,
  server_port: n.hysteria.port,
  password: n.hysteria.authPassword,
  obfs: { type: "salamander", password: n.hysteria.obfsPassword },
  tls: { enabled: true, server_name: n.hysteria.sni, insecure: true },
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
  interval: "3m",
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
 * Each exit outbound targets `127.0.0.1:<port>` with `detour: entry-select` —
 * the inner address resolves at the gateway end of the detour, hitting that
 * exit's rathole loopback there.
 */
export function buildProfile(
  nodes: ResolvedNode[],
  magicdnsSuffix: string,
  exits: ResolvedExit[] = [],
) {
  const outbounds: Record<string, unknown>[] = [];
  for (const n of nodes) {
    outbounds.push(hy2(n), reality(n));
  }
  if (nodes.length === 1) {
    const t = nodes[0].name;
    outbounds.push(urltest("auto", [`hy2-${t}`, `reality-${t}`]));
    outbounds.push(
      selector("entry-select", ["auto", `hy2-${t}`, `reality-${t}`], "auto"),
    );
  } else {
    for (const n of nodes) {
      outbounds.push(
        urltest(`auto-${n.name}`, [`hy2-${n.name}`, `reality-${n.name}`]),
      );
      outbounds.push(
        selector(
          n.name,
          [`auto-${n.name}`, `hy2-${n.name}`, `reality-${n.name}`],
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

  // Each exit: a Shadowsocks outbound dialled through the entry gateway. The
  // 127.0.0.1:<port> resolves at the gateway → its rathole loopback for this
  // exit → the exit's ss-rust → egress at the exit's own IP.
  for (const e of exits) {
    outbounds.push({
      type: "shadowsocks",
      tag: `exit-${e.name}`,
      server: "127.0.0.1",
      server_port: e.port,
      method: e.method,
      password: e.password,
      detour: "entry-select",
    });
  }

  // The exit axis: direct (egress at the gateway) or one of the exits.
  outbounds.push(
    selector(
      "exit-select",
      ["entry-select", ...exits.map((e) => `exit-${e.name}`)],
      "entry-select",
    ),
  );

  return {
    log: { level: "info", timestamp: true },
    dns: {
      servers: [
        { type: "https", tag: "cf-doh", server: "1.1.1.1" },
        {
          type: "udp",
          tag: "ts-dns",
          server: "100.100.100.100",
          detour: "entry-select",
        },
      ],
      rules: [{ domain_suffix: [magicdnsSuffix], server: "ts-dns" }],
      final: "cf-doh",
      strategy: "ipv4_only",
    },
    inbounds: [
      {
        type: "tun",
        tag: "tun-in",
        address: ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
        mtu: 1400,
        auto_route: true,
        strict_route: true,
        stack: "system",
      },
    ],
    outbounds,
    route: {
      default_domain_resolver: "cf-doh",
      rules: [
        { action: "sniff" },
        { protocol: "dns", action: "hijack-dns" },
        {
          // Tailnet egresses at the gateway (into the mesh), never via an exit.
          ip_cidr: ["100.64.0.0/10", "fd7a:115c:a1e0::/48"],
          outbound: "entry-select",
        },
      ],
      final: "exit-select",
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
