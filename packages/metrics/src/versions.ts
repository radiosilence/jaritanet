/**
 * Pinned upstreams for the metrics stack.
 *
 * Full image references except `victoriaMetrics`, which is a bare version: the
 * store and the agent ship from one release and must not skew, since the agent
 * speaks the store's remote-write protocol. One binding is what makes that
 * structural, rather than two config entries the updater has to remember to
 * move in the same run.
 *
 * Rewritten in place by the version updater; see `.github/tracked-versions.yml`.
 */
export const VERSIONS = {
  grafana: "docker.io/grafana/grafana:13.3.2",
  nodeExporter: "quay.io/prometheus/node-exporter:v1.13.1",
  victoriaMetrics: "1.157.0",
} as const;

/**
 * Floats on purpose: the init containers that hand a hostPath over to a
 * non-root uid run one `find … chown`, and busybox publishes no releases for
 * the updater to follow.
 */
export const UNTRACKED = {
  busybox: "docker.io/library/busybox:1.38",
} as const;

export const VM_SINGLE_IMAGE = `docker.io/victoriametrics/victoria-metrics:v${VERSIONS.victoriaMetrics}`;
export const VM_AGENT_IMAGE = `docker.io/victoriametrics/vmagent:v${VERSIONS.victoriaMetrics}`;
