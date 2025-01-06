import * as pulumi from "@pulumi/pulumi";
import { dns, tunnel } from "./modules";
import type { TunnelConf, ZoneConf } from "./types";

const config = new pulumi.Config();

const zones = config.requireObject<ZoneConf[]>("zones");

const jaritanetTunnel = tunnel(
  config.requireObject<TunnelConf>("tunnel").name,
  zones
);

for (const zone of zones) {
  for (const module of zone.modules) {
    dns[module](zone);
  }
}

const demo = {
  a: { a: 3 },
  b: { b: 4 },
};

console.log(demo.b.a);

function t<T extends typeof demo>(input: T) {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, () => value])
  );
}

const d = t(demo);

console.log(d.a().a);

export const { tunnelToken } = jaritanetTunnel;
