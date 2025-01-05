import { type ZoneConf } from "@/types";
import * as cloudflare from "@pulumi/cloudflare";

type RecordArgs = Omit<cloudflare.RecordArgs, "zoneId">;

export function record(
  { zoneId, ...zone }: ZoneConf,
  { name, ...record }: RecordArgs
) {
  new cloudflare.Record(`${zone.name}-${name}`, {
    zoneId,
    name,
    ...record,
    ttl: record.proxied ? 1 : record.ttl,
  });
}
