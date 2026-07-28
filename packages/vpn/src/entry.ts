/**
 * Marks a node as an entry point for the VPN transports.
 *
 * The DaemonSets carrying xray, hysteria, tailscale and unbound select on this
 * rather than on a hostname, so which machine serves an entry is a property of
 * that machine. When `lady` joins the cluster, or an edge does, giving it an
 * entry is a label on the node — not another module and not a config list.
 * The label is applied by whoever owns the node (see infra's gateway.ts).
 *
 * The `jaritanet.dev` prefix is this package's own namespace rather than a
 * caller's: changing it relabels every live entry node and reschedules every
 * transport, so it is a constant to be read, not a knob to be turned.
 */
export const VPN_ENTRY_LABEL = "jaritanet.dev/vpn-entry";
