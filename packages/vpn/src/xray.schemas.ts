import * as z from "zod";
import { sniLabel } from "./reality.ts";
import { HostPort } from "@jaritanet/k8s";

/**
 * Xray-core (VLESS-Vision-REALITY) on the entry node, sharing :443 with
 * whatever fronts the node's own site. Traffic that doesn't match a client is
 * relayed to `dest`; matched clients are proxied out.
 *
 * `serverNames` are the SNIs the inbound accepts. Ideally an SNI matches the
 * cert served at `dest`, but on a gateway that reverse-proxies its own site the
 * two are deliberately decoupled: `dest` must stay the local backend so real
 * visitors are served, while the SNI has to be a name content filters won't
 * intercept — a sparse own-domain gets mis-rated and the tunnel dies with it.
 *
 * It is a list because no single borrowed identity is safe everywhere, and the
 * ways they fail don't overlap: a category filter forges whatever it rates as
 * adult, while a national firewall blocks the big names outright — Google is
 * camouflage in a British pub and a red flag in China, where Microsoft and
 * Apple still pass. The client gets one outbound per name inside its urltest,
 * so it finds the identity that works on the network it's actually on. First
 * entry is the client's default. Keys, shortIds and `dest` are shared across
 * all of them. Distinct first labels, since those name the client outbounds.
 *
 * `dest` defaults to Traefik's local https port; point it at an external
 * "host:port" to use a different backend.
 */
export const XrayConfSchema = z.object({
  dest: HostPort.default("127.0.0.1:8443"),
  serverNames: z
    .array(z.string())
    .min(1)
    .refine((names) => new Set(names.map(sniLabel)).size === names.length, {
      message: "serverNames must have distinct first labels",
    }),
});
