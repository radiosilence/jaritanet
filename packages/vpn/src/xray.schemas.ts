import * as z from "zod";
import { sniLabel } from "./reality.ts";
import { Hostname, HostPort, Port } from "@jaritanet/k8s";

/**
 * Xray-core (VLESS-Vision-REALITY) on the entry node, sharing :443 with
 * whatever fronts the node's own site. Traffic that doesn't match a client is
 * relayed to `dest`; matched clients are proxied out.
 *
 * `serverNames` are the SNIs the inbound accepts. A name that `dest` serves
 * with its own certificate is the strongest identity: SNI, address and
 * certificate then agree for a passive observer and an active probe alike. Not
 * every own name qualifies — content filters intercept by the SNI's reputation
 * category, and a sparse or mis-rated domain gets every handshake forged, so
 * the own name has to be one with an ordinary site behind it. Borrowed names,
 * whose certificate `dest` cannot present, cover the networks where it fails.
 *
 * It is a list because no single identity is safe everywhere, and the ways
 * they fail don't overlap: a category filter forges whatever it rates as
 * adult, while a national firewall blocks the big names outright — Google is
 * camouflage in a British pub and blocked in China, where Microsoft and Apple
 * still pass. The client gets one outbound per name inside its urltest, so it
 * finds the identity that works on the network it's actually on. First entry
 * is the client's default. Keys, shortIds and `dest` are shared across all of
 * them. Distinct first labels, since those name the client outbounds.
 *
 * `dest` defaults to Traefik's local https port; point it at an external
 * "host:port" to use a different backend.
 *
 * `xhttp`, absent by default, adds a second VLESS inbound on XHTTP for a CDN to
 * front: `hostname` is the CDN-facing name, which Traefik routes on a secret
 * path to `port` on this node. Only the pod form (createXray) implements it,
 * since it needs Traefik beside it. See docs/architecture.md, "CDN-fronted
 * XHTTP".
 */
export const XrayConfSchema = z.object({
  dest: HostPort.default("127.0.0.1:8443"),
  serverNames: z
    .array(z.string())
    .min(1)
    .refine((names) => new Set(names.map(sniLabel)).size === names.length, {
      message: "serverNames must have distinct first labels",
    }),
  xhttp: z
    .object({
      hostname: Hostname,
      port: Port.default(10443),
    })
    .optional(),
});
