import * as z from "zod";
import { Hostname } from "@jaritanet/k8s";

const DnsModuleEnum = z.enum(["bluesky", "fastmail"]);

export const ZoneConfSchema = z.object({
  modules: z.array(DnsModuleEnum),
  name: Hostname,
  // Cloudflare zone ids are 32 hex characters.
  zoneId: z
    .string()
    .regex(/^[0-9a-f]{32}$/, "must be a 32-character Cloudflare zone id"),
});

export const ZonesConfSchema = z.array(ZoneConfSchema);

export const FastmailConfSchema = z.object({
  dkimDomain: Hostname,
  dkimSubdomain: z.string(),
  dmarcAggEmail: z.email(),
  dmarcPolicy: z.enum(["none", "quarantine", "reject"]),
  dmarcSubdomain: z.string(),
  mxDomain: Hostname,
  spfDomain: Hostname,
});

export const BlueskyConfSchema = z.object({
  did: z.string(),
});
