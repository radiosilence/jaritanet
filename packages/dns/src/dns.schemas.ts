import * as z from "zod";

const DnsModuleEnum = z.enum(["bluesky", "fastmail"]);

export const ZoneConfSchema = z.object({
  modules: z.array(DnsModuleEnum),
  name: z.string(),
  zoneId: z.string(),
});

export const ZonesConfSchema = z.array(ZoneConfSchema);

export const FastmailConfSchema = z.object({
  dkimDomain: z.string(),
  dkimSubdomain: z.string(),
  dmarcAggEmail: z.string(),
  dmarcPolicy: z.string(),
  dmarcSubdomain: z.string(),
  mxDomain: z.string(),
  spfDomain: z.string(),
});

export const BlueskyConfSchema = z.object({
  did: z.string(),
});
