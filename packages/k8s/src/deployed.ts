/**
 * What a service constructor hands back to the stack that composed it.
 *
 * The stack no longer inspects config to work out what a service needs
 * published or registered — it calls the constructor and reads what comes back.
 * That keeps the two things that must not disagree in one place: the hostname a
 * service is published at and the redirect URI its OAuth client is registered
 * for are the same binding inside the package, so no allowlist entry can hold a
 * typo or outlive the service that moved.
 */

/**
 * A hostname to publish, and the workload answering it.
 *
 * `service` is the name prefix, not the object's name — `createService` names
 * its Service `<prefix>-service` and the IngressRoute derives the same backend
 * from the same prefix, so a route names the pair rather than either half.
 */
export type Route = {
  service: string;
  hostname: string;
  /**
   * Only for a hostname two workloads share. Absent means the whole host,
   * which is what everything else wants.
   */
  paths?: string[];
  priority?: number;
};

/**
 * The OAuth client a service needs registered for it.
 *
 * The callback path is per service because Grafana's is fixed by Grafana —
 * `/login/generic_oauth`, not the `/auth/callback` our own two implement. It is
 * returned rather than configured for the same reason the route is: the service
 * is the only thing that knows it.
 */
export type OidcClient = {
  id: string;
  name: string;
  redirectUri: string;
};

export type Deployed = {
  routes: Route[];
  oidc?: OidcClient;
};
