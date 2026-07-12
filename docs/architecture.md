# Architecture

JARITANET runs one Hetzner VPS that does two unrelated jobs on the same
`:443`, plus a home box behind NAT that never exposes a port. This doc covers
the network topology and the transport/proxy layer; for the Pulumi package
layout and secrets see the [README](../README.md).

## The two data planes

The VPS wears two hats at once:

1. **Reverse proxy** for public home-hosted services (`blit.cc`, Navidrome,
   files). Public visitors hit the VPS; their traffic is tunnelled down to the
   home cluster over rathole. The home IP never appears in DNS and no home port
   is ever opened — the rathole client dials *out*.
2. **Censorship-resistant VPN egress** for the owner's devices. sing-box
   clients connect over Hysteria2 or VLESS-REALITY and egress to the open
   internet directly from the VPS.

The neat part: those two jobs share TCP `:443` deliberately. A public visitor
who doesn't hold a VLESS credential is treated by REALITY as untrusted and
**forwarded to the real service** — so the "decoy" that hides the proxy is
genuine, organically-visited traffic, not a fake.

```mermaid
flowchart LR
    subgraph client["Owner devices"]
        SB["sing-box<br/>auto = urltest of hy2 + reality"]
    end

    subgraph pub["Public visitors"]
        BR["browser<br/>(no VLESS creds)"]
    end

    subgraph vps["Hetzner VPS gateway"]
        XR["Xray VLESS-REALITY<br/>TCP 443"]
        HY["Hysteria2 + Salamander<br/>UDP 443"]
        RH["rathole server<br/>ctrl 2333 / http 80 / https 127.0.0.1:8443"]
        FREE["freedom outbound<br/>direct egress"]
    end

    subgraph home["oldboy — home, behind NAT"]
        RHC["rathole client<br/>dials out"]
        TR["Traefik<br/>TLS termination + routing"]
        SVC["Navidrome · Blit · files"]
    end

    INET(("Open internet"))

    BR -->|"HTTPS to blit.cc"| XR
    SB -->|"reality"| XR
    SB -->|"hy2"| HY

    XR -->|"matched client"| FREE
    HY --> FREE
    FREE --> INET

    XR -->|"unmatched -> dest"| RH
    RHC -. "outbound control + data" .-> RH
    RH --> RHC --> TR --> SVC
```

## How `:443` is multiplexed

TCP and UDP `:443` are independent, so Hysteria2 (UDP) and Xray (TCP) never
collide. The interesting logic is on the TCP side, where Xray owns the port and
REALITY decides per-connection whether it's a proxy client or cover traffic.

```mermaid
flowchart TD
    IN["inbound :443"] --> PROTO{"UDP or TCP?"}
    PROTO -->|UDP| HY["Hysteria2<br/>auth + Salamander deobfs"] --> OUT["freedom -> internet"]
    PROTO -->|TCP| XR["Xray REALITY handshake"]
    XR --> MATCH{"valid VLESS<br/>uuid + shortId?"}
    MATCH -->|yes| OUT
    MATCH -->|"no / active probe"| DEST["dest = 127.0.0.1:8443"]
    DEST --> RH["rathole https"] --> TUN["tunnel to home"] --> TR["Traefik TLS + route"] --> SVC["service"]
```

A censor's active probe lands in the `no` branch: it gets a real TLS session to
the real service and sees a legitimate cert, indistinguishable from any other
visitor. That's what makes REALITY hard to fingerprint.

## Transport protocols

Neither egress transport is WireGuard or OpenVPN — both of those carry fixed,
trivially-classified signatures. These are chosen specifically to *not* look
like a VPN.

| Transport | Wire | DPI stance | Role |
|---|---|---|---|
| **Hysteria2** | QUIC over UDP/443 + Salamander obfs | Defeats protocol fingerprinting; still high-entropy UDP, so vulnerable to "unclassified UDP" heuristics and UDP-hostile networks | Daily driver — fast, loss-tolerant |
| **VLESS-Vision-REALITY** | TCP/443, mimics a real TLS 1.3 session | Strong — passes as genuine HTTPS, survives active probing | Fallback for UDP-blocked / censored networks |

**Why REALITY is slow on lossy links:** it's TCP, and tunnelled app traffic is
mostly TCP, so you stack TCP-in-TCP. Two retransmit + congestion loops fight
each other and back off exponentially on packet loss — the classic TCP
meltdown, plus single-stream head-of-line blocking. Hysteria2 sidesteps both:
QUIC does per-stream loss recovery and treats loss as loss rather than
congestion, so it stays smooth where REALITY crawls. This is a property of the
transports, not a misconfiguration.

**Network expectations:**

- Normal ISPs, mobile, home broadband → hy2 works, fast.
- Hotel / guest / captive-portal wifi → UDP is often blocked or throttled;
  expect frequent fallback to REALITY.
- State censorship (Egypt-tier) → high-entropy UDP is a throttle target; REALITY
  (looks like plain HTTPS) is the more reliable survivor.
- GFW-tier → UDP largely dead; REALITY is what gets through.

The client's `auto` group (urltest) picks whichever is healthy, so a device
degrades gracefully from fast-hy2 to slow-but-alive REALITY without manual
intervention.

## Client routing (sing-box)

One combined profile carries both transports, an embedded Tailscale endpoint,
and DNS handling. Egress rides the `select`/`auto` groups; tailnet IPs split off
to the Tailscale endpoint so tailnet access and censorship egress coexist in a
single tunnel — which also means it works on iOS, where only one VPN can run.

```mermaid
flowchart TD
    APP["app traffic"] --> SNIFF["sniff"]
    SNIFF --> DNSQ{"port 53?"}
    DNSQ -->|yes| HIJACK["hijack-dns"]
    HIJACK --> RESOLVE{"tailnet suffix?"}
    RESOLVE -->|yes| TSDNS["ts-dns<br/>MagicDNS from tsnet netmap"]
    RESOLVE -->|no| DOH["cf-doh<br/>DoH 1.1.1.1 over tunnel"]
    DNSQ -->|no| DEST{"dest IP in<br/>100.64.0.0/10?"}
    DEST -->|yes| TS["Tailscale endpoint<br/>accept_routes false"]
    DEST -->|no| SEL["select -> auto<br/>urltest(hy2, reality)"]
    SEL --> VPS["VPS egress"]
```

Two client settings are load-bearing and must not be dropped:

- **`hijack-dns`** (after `sniff` in `route.rules`). Without it, sing-box flings
  port-53 queries out the tunnel as raw packets to a dead internal resolver;
  nothing resolves except cached names and the client looks offline. With it,
  queries are answered via DoH to 1.1.1.1 — encrypted and tunnelled, no leak.
- **`accept_routes: false`** on the Tailscale endpoint. With `true`, a tailnet
  node advertising routes gets its routes accepted and swallows the default
  route → total blackout. Tailnet stays reachable via the explicit
  `100.64.0.0/10` route rule instead.

See [`clients/README.md`](../clients/README.md) for the fill-in template and how
the profile is delivered to devices.

## Hardening notes

Live tradeoffs worth knowing, not necessarily bugs:

- **The REALITY decoy is our own domain, and that's load-bearing — not a
  weakness to "fix."** REALITY has a single `dest` fallback, and every non-proxy
  TCP/443 connection (i.e. every real public visitor to the site) is forwarded
  there. Because `dest` is the home Traefik backend, visitors get the genuine
  site. Repointing `dest` at an external site (`www.microsoft.com` etc.) to
  borrow bigger crowd cover would serve *that* site to real visitors and break
  public access — you cannot both reverse-proxy your own domain on :443 and
  mimic someone else's. The cover is fine as-is: a real LE cert, real organic
  traffic, an unremarkable small HTTPS site. The only threat it doesn't beat is
  allowlist-style censorship (block everything except known-good domains), which
  is rare and extreme.
- **hy2 uses `insecure=1` + a self-signed cert.** Fine in practice — Salamander
  wraps the whole handshake so the cert never appears on the wire, and the obfs
  password gates access — but there's no cert pinning.
- **SSH (22) and rathole control (2333) are open to the world.** Both are
  authenticated (SSH is key-only ED25519; rathole is 64-char token). Tailnet-
  gating SSH would shrink the attack surface but adds lockout risk on a box
  whose whole job is being reachable, so it's left open by choice. 2333 must
  stay open regardless: the home client dials in from a dynamic NATed IP.
- **No hy2 bandwidth hints** in the client, so it runs default congestion
  control rather than Brutal — usually the friendlier choice on variable links.
