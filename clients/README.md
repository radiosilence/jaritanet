# sing-box client

`singbox.template.json` is a [sing-box](https://sing-box.sagernet.org/) client
config for the gateway. It carries two transports behind a selector:

- **`hy2`** (Hysteria2 / QUIC-UDP) — daily driver. Loss-tolerant, so it stays
  smooth on lossy links where TCP melts down. Salamander obfs hides it from DPI.
- **`reality`** (VLESS-Vision-REALITY / TCP) — fallback for UDP-hostile networks
  (some state censors throttle/block UDP). Slower, but survives where QUIC can't.
- **`auto`** (urltest) picks the working/faster of the two; **`select`** lets you
  pin one manually (sing-box "Groups" tab shows the live pick + latency).

Tailnet traffic (`100.64.0.0/10`) is routed through the same `select` group, so
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

## Filling it in

Replace the `<PLACEHOLDER>` tokens. Everything but the MagicDNS suffix comes
from Pulumi stack outputs (run in `packages/infra/`):

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

Host the filled config at an unguessable path on the file server and add it in
sing-box as a **Remote** profile (URL). sing-box only accepts a JSON config there,
not a `vless://`/`hysteria2://` share link. Remote profiles auto-refresh, so
editing the hosted file and re-pushing updates every device on "Update".

The filled config contains live credentials — do not commit it; only this
template belongs in the repo.
