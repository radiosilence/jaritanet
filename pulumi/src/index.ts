import { dns, tunnel } from "./modules";
import type { TunnelConf, ZoneConf } from "./types";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();

const zones = config.requireObject<ZoneConf[]>("zones");
const tunnelConfig = config.requireObject<TunnelConf>("tunnel");

const jaritanetTunnel = tunnel.cloudflareTunnel({
  ...tunnelConfig,
  zones: Object.values(zones),
});

for (const zone of zones) {
  for (const module of ["bluesky", "fastmail"] as const) {
    if (zone.modules.includes(module)) {
      dns[module](zone);
    }
  }
}

export const tunnelToken = jaritanetTunnel.tunnelToken;
