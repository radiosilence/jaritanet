# sing-box client

`templates/singbox.template.json.j2` renders a
[sing-box](https://sing-box.sagernet.org/) client profile covering **every
node** — the primary gateway plus each edge — behind a nested location picker.

Per node there are two transports:

- **`hy2`** (Hysteria2 / QUIC-UDP) — daily driver. Loss-tolerant, so it stays
  smooth on lossy links where TCP melts down. Salamander obfs hides it from DPI.
- **`reality`** (VLESS-Vision-REALITY / TCP) — fallback for UDP-hostile networks.
  Slower, but survives where QUIC can't.

## The picker

The group structure **expands with node count**, so a single-node profile
stays simple and the nesting only appears when it earns its keep:

- **One node** → flat: `main` (selector) over `[auto, hy2-<host>, reality-<host>]`,
  defaulting to `auto`. Two groups in the app — obvious.
- **Two+ nodes** → nested:
  - **`main`** (top selector) — `auto-all` (fastest transport across every node)
    or a specific host group.
  - **`<host>`** (per-node selector, e.g. `helsinki`) — that node's `auto-<host>`,
    or force `hy2-<host>` / `reality-<host>` for field experimentation.
  - **`auto-<host>`** / **`auto-all`** — urltest groups that auto-pick the
    live/fastest transport.

Routing always points at `main`, so the rest of the config is count-agnostic.
Leaf outbound tags are prefixed per host (`hy2-helsinki`, …) because sing-box
tags must be globally unique; the selectors are what you navigate in the app's
Groups tab. These are *choices*, not a chain — traffic flows through exactly one
resolved transport, not through every group in sequence.

Tailnet traffic (`100.64.0.0/10`) routes through `main` too, so it rides
hy2/reality to whichever node is selected — each node is a tailnet member and
dials the destination over the mesh. On a Tailscale-hostile network `100.x`
still works because the only leg crossing it is the obfuscated tunnel. For fast,
direct tailnet on an open network, use the native Tailscale app instead (one VPN
slot on iOS: native for speed, this profile for survival).

MagicDNS (`*.<tailnet>.ts.net`) resolves via `ts-dns`, a plain resolver at
`100.100.100.100` detoured through `main` so a node answers on the client's
behalf. If that misbehaves on your sing-box version, use raw `100.x` IPs.

Load-bearing — do not drop: **`route.rules` has `sniff` + `hijack-dns`.**
Without `hijack-dns`, sing-box flings port-53 queries out the tunnel as raw
packets to a dead internal resolver; nothing resolves and the client looks
offline. With it, queries go via `cf-doh` (DoH → 1.1.1.1, tunnelled).

## How it's generated

Pulumi is the single source of truth. It emits every node's data (IP/hostname,
hy2 + reality credentials) as the secret `singboxNodes` stack output. On each
deploy (`ci-cd.yml`) that output is piped to this role as `SINGBOX_NODES`, the
Jinja2 template renders the multi-node profile, it's written to the file
server's unguessable path, and the URL + a QR are pushed to Telegram whenever
the profile actually changes. **No per-value secrets** — add a node by adding an
`edges` entry in `Pulumi.main.yaml`; the next deploy regenerates and notifies.

- **Onboard a device** without a config change: re-run with
  `SINGBOX_FORCE_NOTIFY=1` to re-push the QR.
- **Rotate** the hosted path by changing `SINGBOX_SLUG`.

The template validates as JSON before it's placed, so a broken render never
overwrites a working profile.

## Delivering it to clients

Add it in sing-box as a **Remote** profile (the URL Telegram pushed). Remote
profiles auto-refresh, so a re-render updates every device on "Update" — one
edit, all devices. The unguessable path is the only thing guarding the profile,
so treat the URL as a secret; the rendered config carries live credentials and
lives only on the file server (`/srv/files/.sfm/`), never in the repo.
