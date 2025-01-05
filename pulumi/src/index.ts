import * as pulumi from "@pulumi/pulumi";
import { type ZoneConf } from "@/types";
import { fastmail } from "@/modules";

const config = new pulumi.Config();
console.log(config.get("cloudflare:email"));

const zones: Record<string, ZoneConf> = {
  blit: {
    zoneId: "8aa9988e3df6b6a6ab4e4e6dbc3a2451",
    name: "blit.cc",
  },
  buttholes: {
    zoneId: "1115a1e5006523692d61e49e672f6df0",
    name: "buttholes.live",
  },
  radiosilence: {
    zoneId: "3373ad7c3dc3104e7aeab31c1176e684",
    name: "radiosilence.dev",
  },
};

fastmail({ zone: zones.blit });

fastmail({ zone: zones.buttholes });

fastmail({ zone: zones.radiosilence });
