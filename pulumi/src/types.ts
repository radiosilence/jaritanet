/**
 * Configuration for the Cloudflare provider.
 */
export interface CloudflareConf {
  /**
   * Cloudflare account ID.
   */
  accountId: string;
}

/**
 * Configuration for Fastmail DNS records.
 */
export interface FastmailConf {
  mxDomain: string;
  dkimDomain: string;
  dkimSubdomain: string;
  dmarcSubdomain: string;
  dmarcAggEmail: string;
  dmarcPolicy: string;
  spfDomain: string;
}

/**
 * Configuration for Bluesky DNS records.
 */
export interface BlueskyConf {
  /**
   * Bluesky requires a DID to be set in the DNS records for authentication.
   */
  did: string;
}

/**
 * Configuration for a tunneled service.
 */
export interface ServiceConf {
  /**
   * Record name for the service.
   */
  name: string;

  /**
   * Internal service URL.
   */
  service: string;
}

/**
 * Current types of DNS modules.
 */
type DnsModule = "bluesky" | "fastmail";

/**
 * Configuration for a Cloudflare tunnel.
 */
export interface TunnelConf {
  name: string;
}

/**
 * Configuration for a zone.
 */
export interface ZoneConf {
  /**
   * The Cloudflare ID of the zone.
   */
  zoneId: string;

  /**
   * The name of the zone.
   */
  name: string;

  /**
   * DNS modules to apply.
   */
  modules: DnsModule[];

  /**
   * Services to tunnel.
   */
  services?: ServiceConf[];
}
