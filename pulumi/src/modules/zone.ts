import { type ZoneConf } from "@/types";
import * as cloudflare from "@pulumi/cloudflare";

export class Zone {
  conf: ZoneConf;

  constructor(conf: ZoneConf) {
    this.conf = conf;
  }
}
