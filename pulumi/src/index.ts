import * as pulumi from "@pulumi/pulumi";
import { type ZoneConf } from "./types";
import { dns, tunnel } from "./modules";

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

tunnel.cloudflareTunnel({
  name: "jaritanet",
  services: [
    {
      zone: zones.blit,
      name: "@",
      hostname: zones.blit.name,
      service: "http://blit-service.blit.svc.cluster.local",
    },
    {
      zone: zones.blit,
      name: "music",
      hostname: `music.${zones.blit.name}`,
      service: "http://navidrome-service.navidrome.svc.cluster.local",
    },
    {
      zone: zones.radiosilence,
      name: "files",
      hostname: `files.${zones.radiosilence.name}`,
      service: "http://files-service.files.svc.cluster.local",
    },
    {
      zone: zones.radiosilence,
      name: "bambi",
      hostname: `bambi.${zones.radiosilence.name}`,
      service: "http://bambi-art-service.bambi-art.svc.cluster.local",
    },
  ],
});

dns.fastmail(zones.blit);
dns.bluesky(zones.blit);

dns.fastmail(zones.buttholes);
dns.bluesky(zones.buttholes);

dns.fastmail(zones.radiosilence);
dns.bluesky(zones.radiosilence);
