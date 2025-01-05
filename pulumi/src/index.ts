import * as pulumi from "@pulumi/pulumi";
import { dns, tunnel } from "./modules";
import type { TunnelConf, ZoneConf } from "./types";

const config = new pulumi.Config();

const zones = config.requireObject<ZoneConf[]>("zones");

const jaritanetTunnel = tunnel({
  ...config.requireObject<TunnelConf>("tunnel"),
  zones,
});

for (const zone of zones) {
  for (const module of zone.modules) {
    dns[module](zone);
  }
}

export const { tunnelToken } = jaritanetTunnel;
