export interface CloudflareConf {
  accountId: string;
}

export interface FastmailConf {
  mxDomain: string;
  dkimDomain: string;
  dkimSubdomain: string;
  dmarcSubdomain: string;
  dmarcAggEmail: string;
  dmarcPolicy: string;
  spfDomain: string;
}

export interface BlueskyConf {
  did: string;
}

export interface ServiceConf {
  name: string;
  service: string;
}

type DnsModule = "bluesky" | "fastmail";

export interface TunnelConf {
  name: string;
}

export interface ZoneConf {
  zoneId: string;
  name: string;
  modules: DnsModule[];
  services?: ServiceConf[];
}
