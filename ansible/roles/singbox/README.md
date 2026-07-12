# sing-box client

`files/singbox.template.json` is a [sing-box](https://sing-box.sagernet.org/)
client config for the gateway. It carries two transports behind a selector:

- **`hy2`** (Hysteria2 / QUIC-UDP) — daily driver. Loss-tolerant, so it stays
  smooth on lossy links where TCP melts down. Salamander obfs hides it from DPI.
- **`reality`** (VLESS-Vision-REALITY / TCP) — fallback for UDP-hostile networks
  (some state censors throttle/block UDP). Slower, but survives where QUIC can't.
- **`auto`** (urltest) picks the working/faster of the two; **`main`** (selector)
  is the group you tap in the app's "Groups" tab to pin one manually (it shows
  the live pick + latency). `main` is `route.final` — all traffic enters here,
  defaulting to `auto`.

Tailnet traffic (`100.64.0.0/10`) is routed through the same `main` group, so
it rides hy2/reality to the gateway VPS — which is itself a tailnet member and
dials the destination over the mesh. This is the censorship-resistant tailnet
path: on a network that blocks Tailscale (control plane + DERP), `100.x` still
works because the only leg crossing the hostile network is the obfuscated
tunnel. It's slower (traffic relays through the VPS) and there's no WireGuard on
the client at all — for fast, direct tailnet on an open network, just use the
native Tailscale app instead. One VPN slot on iOS: native for speed, this
profile for survival.

MagicDNS (`*.<tailnet>.ts.net`) resolves via `ts-dns`, a plain resolver pointed
at the tailnet's `100.100.100.100` and detoured through the tunnel so the VPS
answers on the client's behalf. If that misbehaves on your sing-box version, use
raw `100.x` IPs — they always route.

One setting is load-bearing — do not drop it:

- **`route.rules` has `sniff` + `hijack-dns`.** Without the `hijack-dns` rule,
  sing-box routes port-53 queries out the tunnel as raw packets to its own dead
  internal DNS address; nothing resolves (only cached lookups work) and clients
  appear to "lose connection." With it, queries are answered via `cf-doh`
  (DoH → 1.1.1.1, routed over the tunnel — encrypted and unleakable).

## Generating it (automated)

The `singbox` ansible role renders this template into the hosted profile on
every `ansible/**` deploy — no manual filling. It substitutes the `SINGBOX_*`
GitHub Actions secrets for the `<PLACEHOLDER>` tokens, writes the result to the
file server's unguessable path, and pushes the URL + a QR to Telegram whenever
the profile actually changes.

- **Seed the secrets** from an existing hosted profile (values are piped
  straight to `gh`, never printed):
  `./scripts/set-singbox-secrets https://<host>/.sfm/<slug>.json`
  It also prompts for a Telegram bot token and auto-detects your chat id.
- **Rotate** by changing `SINGBOX_SLUG` (new path) or any transport secret and
  re-running the playbook.
- **Onboard a new device** without a config change by re-running with
  `SINGBOX_FORCE_NOTIFY=1` to re-push the QR.

This template is the single source of truth — the role reads it directly, so a
new `<PLACEHOLDER>` here just needs a matching entry in
`ansible/roles/singbox/vars/main.yml` (the render fails loudly if one is
unmapped).

## Filling it in (manual)

To build one by hand, replace the `<PLACEHOLDER>` tokens. Everything but the
MagicDNS suffix comes from Pulumi stack outputs (run in `packages/infra/`):

| Placeholder | Source |
| --- | --- |
| `<VPS_IP>` | `pulumi stack output vpsIp` |
| `<XRAY_UUID>` | `pulumi stack output xrayUuid` |
| `<XRAY_PUBLIC_KEY>` | `pulumi stack output xrayPublicKey` |
| `<XRAY_SHORT_ID>` | `pulumi stack output xrayShortId` |
| `<XRAY_SERVER_NAME>` | `pulumi stack output xrayServerName` |
| `<HYSTERIA_AUTH_PASSWORD>` | from `pulumi stack output hysteriaShareUrl --show-secrets` (the `user@` part) |
| `<HYSTERIA_OBFS_PASSWORD>` | from the same URL (`obfs-password=`) |
| `<TAILNET_MAGICDNS_SUFFIX>` | `tailscale status --json \| jq -r .MagicDNSSuffix` (e.g. `foo-bar.ts.net`) |

The tailnet relay's own auth key is a deploy-side secret (`TS_AUTHKEY`), not a
client value — see `docs/architecture.md`.

The `xrayShareUrl` and `hysteriaShareUrl` outputs are complete `vless://` /
`hysteria2://` URLs if you'd rather import a single transport directly instead of
this combined config.

## Delivering it to clients

Add it in sing-box as a **Remote** profile (the URL Telegram pushed you).
sing-box only accepts a JSON config there, not a `vless://`/`hysteria2://` share
link. Remote profiles auto-refresh, so a re-render updates every device on
"Update" — one edit, all devices. The unguessable path is the only thing
guarding the profile, so treat the URL as a secret.

The rendered config contains live credentials — it lives only on the file
server (`/srv/files/.sfm/`), never in the repo; only this template belongs here.
