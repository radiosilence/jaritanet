import * as yaml from "yaml";

/**
 * Where the projected ServiceAccount token lands. The kubelet's metrics
 * endpoints authenticate with it, which is why vmagent is the one workload here
 * that mounts one at all.
 */
const SA_TOKEN = "/var/run/secrets/kubernetes.io/serviceaccount/token";

/**
 * Values vmagent substitutes into the config at startup, from the downward API.
 *
 * `%{VAR}` is VictoriaMetrics' own expansion in `-promscrape.config`, and it is
 * what lets one ConfigMap serve every node: each agent resolves the placeholders
 * to its own machine. Without it the config would have to name a node, and a
 * DaemonSet would need one ConfigMap per member.
 */
export const NODE_NAME = "%{NODE_NAME}";
export const NODE_IP = "%{NODE_IP}";
export const NAMESPACE = "%{NAMESPACE}";

/**
 * What one agent scrapes: its own node, and nothing else.
 *
 * That is the design decision worth stating. A single central scraper reaching
 * across to the home box would turn every residential-uplink blip into a hole
 * in the graphs, because a missed scrape is simply lost. A local scrape with a
 * buffered remote-write replays the gap when the link comes back, and it halves
 * the cross-link chatter besides.
 *
 * The node's own IP, not `localhost`: the agent runs in the pod network so it
 * can reach pod addresses directly, while node-exporter, the kubelet and Cilium
 * all bind the host. `status.hostIP` is the address the cluster already knows
 * that node by, which on the home box is its tailnet address.
 *
 * Cilium and Hubble are named as static targets rather than discovered by
 * annotation. Both metrics servers live on the same agent pod, so one
 * `prometheus.io/port` annotation cannot describe both, and whichever the chart
 * happens to write would silently be the only one scraped.
 */
export function scrapeConfig(scrapeInterval: string) {
  const onThisNode = (port: number) => [{ targets: [`${NODE_IP}:${port}`] }];

  // The kubelet serves its own metrics and cAdvisor's on one port, behind one
  // certificate signed by a CA pods are not given. Verification therefore
  // cannot succeed; the bearer token is what authenticates the caller, and the
  // callee is this pod's own node.
  const kubelet = (metricsPath: string) => ({
    scheme: "https",
    metrics_path: metricsPath,
    tls_config: { insecure_skip_verify: true },
    bearer_token_file: SA_TOKEN,
    static_configs: onThisNode(10250),
  });

  return yaml.stringify({
    global: {
      scrape_interval: scrapeInterval,
      // Which machine a sample came from, on every series. `instance` already
      // separates the two nodes, but it is an address — it changes when a pod
      // moves and reads as nothing when a panel is grouped by it.
      external_labels: { node: NODE_NAME },
    },
    scrape_configs: [
      { job_name: "node-exporter", static_configs: onThisNode(9100) },
      { job_name: "kubelet", ...kubelet("/metrics") },
      { job_name: "cadvisor", ...kubelet("/metrics/cadvisor") },
      // NetworkPolicy drop counters, which is how "the policies are enforced
      // now" stops being a belief. `up` going to 0 here means Cilium was
      // deployed without `prometheus.enabled`, not that nothing is dropping.
      { job_name: "cilium-agent", static_configs: onThisNode(9962) },
      { job_name: "hubble", static_configs: onThisNode(9965) },
      {
        job_name: "pods",
        kubernetes_sd_configs: [
          { role: "pod", namespaces: { names: [NAMESPACE] } },
        ],
        relabel_configs: [
          // Own node only — the other agent has the same list and would
          // otherwise scrape the same pod twice.
          {
            source_labels: ["__meta_kubernetes_pod_node_name"],
            regex: NODE_NAME,
            action: "keep",
          },
          {
            source_labels: [
              "__meta_kubernetes_pod_annotation_prometheus_io_scrape",
            ],
            regex: "true",
            action: "keep",
          },
          // The annotated port replaces whatever the first container declares.
          {
            source_labels: [
              "__address__",
              "__meta_kubernetes_pod_annotation_prometheus_io_port",
            ],
            regex: String.raw`([^:]+)(?::\d+)?;(\d+)`,
            replacement: "$1:$2",
            target_label: "__address__",
          },
          {
            source_labels: [
              "__meta_kubernetes_pod_annotation_prometheus_io_path",
            ],
            regex: "(.+)",
            target_label: "__metrics_path__",
          },
          {
            source_labels: ["__meta_kubernetes_pod_name"],
            target_label: "pod",
          },
          {
            source_labels: ["__meta_kubernetes_pod_label_app"],
            target_label: "app",
          },
        ],
      },
    ],
  });
}
