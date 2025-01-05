import * as pulumi from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";
const config = new pulumi.Config();
console.log(config.get("cloudflare:email"));
interface ZoneConf {
  id: string;
  name: string;
}

const zones: Record<string, ZoneConf> = {
  blit: {
    id: "8aa9988e3df6b6a6ab4e4e6dbc3a2451",
    name: "blit.cc",
  },
  buttholes: {
    id: "1115a1e5006523692d61e49e672f6df0",
    name: "buttholes.live",
  },
  radiosilence: {
    id: "3373ad7c3dc3104e7aeab31c1176e684",
    name: "radiosilence.dev",
  },
};

export const pulumiRecord = new cloudflare.Record("radiosilence-pulumi", {
  zoneId: zones.radiosilence.id,
  name: "pulumi",
  content: "127.0.0.1",
  type: "A",
  proxied: false,
});
