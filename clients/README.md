# sing-box client

`singbox.template.json` is a [sing-box](https://sing-box.sagernet.org/) client
config for the gateway. It carries two transports behind a selector:

- **`hy2`** (Hysteria2 / QUIC-UDP) — daily driver. Loss-tolerant, so it stays
  smooth on lossy links where TCP melts down. Salamander obfs hides it from DPI.
- **`reality`** (VLESS-Vision-REALITY / TCP) — fallback for UDP-hostile networks
  (some state censors throttle/block UDP). Slower, but survives where QUIC can't.
- **`auto`** (urltest) picks the working/faster of the two; **`select`** lets you
  pin one manually (sing-box "Groups" tab shows the live pick + latency).

Tailnet traffic (`100.64.0.0/10`) is split off through an embedded Tailscale
endpoint, so tailnet access and censorship-resistant egress coexist in one tunnel
— no second VPN app, and it works on iOS where only one VPN can run at a time.

## Filling it in

Replace the `<PLACEHOLDER>` tokens. Everything but the Tailscale key and MagicDNS
suffix comes from Pulumi stack outputs (run in `packages/infra/`):

| Placeholder | Source |
| --- | --- |
| `<VPS_IP>` | `pulumi stack output vpsIp` |
| `<XRAY_UUID>` | `pulumi stack output xrayUuid` |
| `<XRAY_PUBLIC_KEY>` | `pulumi stack output xrayPublicKey` |
| `<XRAY_SHORT_ID>` | `pulumi stack output xrayShortId` |
| `<XRAY_SERVER_NAME>` | `pulumi stack output xrayServerName` |
| `<HYSTERIA_AUTH_PASSWORD>` | from `pulumi stack output hysteriaShareUrl --show-secrets` (the `user@` part) |
| `<HYSTERIA_OBFS_PASSWORD>` | from the same URL (`obfs-password=`) |
| `<TAILSCALE_AUTH_KEY>` | Tailscale admin → Settings → Keys → generate (reusable + ephemeral) |
| `<TAILNET_MAGICDNS_SUFFIX>` | `tailscale status --json \| jq -r .MagicDNSSuffix` (e.g. `foo-bar.ts.net`) |

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
