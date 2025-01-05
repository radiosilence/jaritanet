import * as cloudflare from "@pulumi/cloudflare";
import type { ZoneConf } from "../../types";

type RecordArgs = Omit<cloudflare.RecordArgs, "zoneId"> & { name: string };

/**
 * A simple wrapper around CloudFlare record that takes the Zone as an argument.
 *
 * @param zone - The zone to create the record in.
 * @param args - The arguments to pass to the record.
 */
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
