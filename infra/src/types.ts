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
 * Configuration for a Cloudflare tunnel.
 */
export interface TunnelConf {
  name: string;
}
