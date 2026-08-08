import { AbsolutePath, Hostname, LimitsSchema } from "@jaritanet/k8s";
import * as z from "zod";

/**
 * How long the store keeps a sample.
 *
 * VictoriaMetrics spells this `<n>[hdwy]` and rejects anything else at startup,
 * which is a crash loop rather than a parse error — so it is checked here,
 * where the message names the value.
 */
const Retention = z
  .string()
  .regex(/^\d+[hdwy]$/, "must be a VictoriaMetrics retention, e.g. 30d or 1y");

/**
 * A Prometheus duration — a scrape interval, here.
 */
const Duration = z
  .string()
  .regex(/^\d+[smhd]$/, "must be a duration, e.g. 30s or 5m");

/**
 * Storage, collection and a dashboard, as one thing.
 *
 * Four workloads rather than four services because none of them is useful
 * alone and their wiring is derived: the agents remote-write to the store by
 * its in-cluster name, Grafana reads the store by the same name, and the
 * exporter exists only to be scraped. Splitting them into `kind: web` entries
 * would put that wiring in config, where the three copies could disagree.
 *
 * VictoriaMetrics rather than kube-prometheus-stack because the box carrying
 * this also carries the control plane, Cilium, Traefik, two VPN transports,
 * Hydra and Postgres. `vmsingle` is one binary with a Prometheus-compatible
 * query API, so every PromQL expression and every dashboard written against
 * Prometheus still works — at roughly a quarter of the memory. What is given up
 * is the operator ecosystem, and with two nodes and a fixed target list the
 * static scrape config is not the part that hurts.
 */
export const MetricsConfSchema = z.strictObject({
  /**
   * Where Grafana is published. Empty means the collection half is deployed and
   * the dashboard is not — see `createMetrics`, which refuses to stand up a
   * Grafana nobody can sign in to.
   */
  hostname: Hostname.or(z.literal("")).default(""),
  grafana: z.strictObject({
    image: z.string(),
    /**
     * Grafana's sqlite: which OIDC subject is which user, their preferences,
     * and anything built in the UI. Provisioned dashboards are rebuilt from
     * ConfigMaps on every start and do not depend on this.
     */
    hostPath: AbsolutePath.default("/var/lib/jaritanet/grafana"),
    limits: LimitsSchema.default({ cpu: "500m", memory: "512Mi" }),
  }),
  nodeExporter: z.strictObject({
    image: z.string(),
    limits: LimitsSchema.default({ cpu: "200m", memory: "128Mi" }),
  }),
  /**
   * Which machine holds the metrics store and Grafana's state.
   *
   * One value for both, because they are one failure domain: a dashboard whose
   * store is on another node goes dark exactly when the link between them does.
   * It belongs on the gateway rather than the home box for the same reason —
   * the home internet dropping is when the graphs are most wanted.
   */
  storageNode: z.string().min(1),
  vmagent: z.strictObject({
    image: z.string(),
    limits: LimitsSchema.default({ cpu: "500m", memory: "256Mi" }),
    scrapeInterval: Duration.default("30s"),
  }),
  vmsingle: z.strictObject({
    image: z.string(),
    /**
     * A host directory rather than a `local` PersistentVolume: kubelet refuses
     * to mount a local volume whose path does not exist, and nothing in this
     * program can create a directory on a node. `DirectoryOrCreate` makes the
     * first deploy the thing that creates it.
     */
    hostPath: AbsolutePath.default("/var/lib/jaritanet/victoria-metrics"),
    limits: LimitsSchema.default({ cpu: "1", memory: "1Gi" }),
    retention: Retention.default("1y"),
  }),
});
