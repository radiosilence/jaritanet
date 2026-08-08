/**
 * The dashboards Grafana is provisioned with.
 *
 * Built here rather than pasted in as exported JSON so the panels stay
 * readable and the queries stay reviewable — an exported dashboard is several
 * thousand lines of editor state around a dozen expressions, and a diff on it
 * says nothing. Anything built in the UI on top of these is Grafana's own state
 * and lives in its volume; these three are rebuilt from the ConfigMap on every
 * start, which is what makes them safe to change here.
 */

/** Fixed in the provisioned datasource, so panels can name it. */
export const DATASOURCE_UID = "victoriametrics";

type Panel = {
  title: string;
  /** Grafana unit id — `bytes`, `Bps`, `percent`, `percentunit`, `s`, `reqps`. */
  unit?: string;
  description?: string;
  max?: number;
  /** `[expression, legend]`, in query order. */
  targets: [string, string][];
};

/**
 * Two panels per row, eight rows high, in declaration order.
 *
 * `$__rate_interval` rather than a fixed window: Grafana sizes it from the
 * panel's own resolution and the scrape interval, so a zoomed-out panel does
 * not average a spike into nothing and a zoomed-in one still has samples to
 * work with.
 */
function dashboard(uid: string, title: string, panels: Panel[]) {
  return {
    uid,
    title,
    tags: ["jaritanet"],
    timezone: "browser",
    schemaVersion: 41,
    refresh: "1m",
    time: { from: "now-24h", to: "now" },
    panels: panels.map((panel, i) => ({
      type: "timeseries",
      id: i + 1,
      title: panel.title,
      ...(panel.description && { description: panel.description }),
      gridPos: { h: 8, w: 12, x: (i % 2) * 12, y: Math.floor(i / 2) * 8 },
      datasource: { type: "prometheus", uid: DATASOURCE_UID },
      fieldConfig: {
        defaults: {
          unit: panel.unit ?? "short",
          min: 0,
          ...(panel.max !== undefined && { max: panel.max }),
          custom: { fillOpacity: 10, showPoints: "never" },
        },
        overrides: [],
      },
      options: {
        legend: {
          displayMode: "table",
          placement: "bottom",
          calcs: ["lastNotNull", "max"],
        },
        tooltip: { mode: "multi", sort: "desc" },
      },
      targets: panel.targets.map(([expr, legendFormat], n) => ({
        expr,
        legendFormat,
        refId: String.fromCharCode(65 + n),
      })),
    })),
  };
}

/**
 * The kernel names a disk by enumeration order, so `sdb` is whichever external
 * was plugged in second this boot. Panels keyed on a mountpoint survive a
 * replug; panels keyed on a device do not, and say so.
 */
const DEVICE_LABEL_CAVEAT =
  "Keyed on the kernel device name, which is assigned by enumeration order — " +
  "replug the externals in a different order and a series follows the name, not the disk.";

/** Real filesystems. tmpfs and the container overlays are noise here. */
const REAL_FS = 'fstype!~"tmpfs|ramfs|squashfs|overlay|fuse.*"';

const disks = dashboard("jaritanet-disks", "Disks", [
  {
    title: "Filesystem used",
    unit: "percent",
    max: 100,
    description:
      "Keyed on mountpoint, which is stable across a replug. This is the one to alert on.",
    targets: [
      [
        `100 - (node_filesystem_avail_bytes{${REAL_FS}} / node_filesystem_size_bytes{${REAL_FS}} * 100)`,
        "{{node}} {{mountpoint}}",
      ],
    ],
  },
  {
    title: "Filesystem free",
    unit: "bytes",
    targets: [
      [`node_filesystem_avail_bytes{${REAL_FS}}`, "{{node}} {{mountpoint}}"],
    ],
  },
  {
    title: "Read throughput",
    unit: "Bps",
    description: DEVICE_LABEL_CAVEAT,
    targets: [
      [
        "rate(node_disk_read_bytes_total[$__rate_interval])",
        "{{node}} {{device}}",
      ],
    ],
  },
  {
    title: "Write throughput",
    unit: "Bps",
    description: DEVICE_LABEL_CAVEAT,
    targets: [
      [
        "rate(node_disk_written_bytes_total[$__rate_interval])",
        "{{node}} {{device}}",
      ],
    ],
  },
  {
    title: "Utilisation",
    unit: "percentunit",
    description: `Share of wall-clock time the device spent servicing IO. ${DEVICE_LABEL_CAVEAT}`,
    targets: [
      [
        "rate(node_disk_io_time_seconds_total[$__rate_interval])",
        "{{node}} {{device}}",
      ],
    ],
  },
  {
    title: "Queue depth",
    description: `Average number of requests in flight — where a mechanical disk being the bottleneck shows up. ${DEVICE_LABEL_CAVEAT}`,
    targets: [
      [
        "rate(node_disk_io_time_weighted_seconds_total[$__rate_interval])",
        "{{node}} {{device}}",
      ],
    ],
  },
]);

const nodes = dashboard("jaritanet-nodes", "Nodes", [
  {
    title: "CPU busy",
    unit: "percent",
    max: 100,
    targets: [
      [
        '100 - (avg by (node) (rate(node_cpu_seconds_total{mode="idle"}[$__rate_interval])) * 100)',
        "{{node}}",
      ],
    ],
  },
  {
    title: "Memory used",
    unit: "percent",
    max: 100,
    description:
      "Against MemAvailable, so page cache counts as free — which is what it is.",
    targets: [
      [
        "(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100",
        "{{node}}",
      ],
    ],
  },
  {
    title: "Load average",
    targets: [
      ["node_load1", "{{node}} 1m"],
      ["node_load15", "{{node}} 15m"],
    ],
  },
  {
    title: "Network throughput",
    unit: "Bps",
    description:
      "Physical and tunnel interfaces. The per-pod veths are excluded — there is one per container and they say nothing on their own.",
    targets: [
      [
        'rate(node_network_receive_bytes_total{device!~"lo|cilium.*|lxc.*|veth.*"}[$__rate_interval])',
        "{{node}} {{device}} rx",
      ],
      [
        'rate(node_network_transmit_bytes_total{device!~"lo|cilium.*|lxc.*|veth.*"}[$__rate_interval])',
        "{{node}} {{device}} tx",
      ],
    ],
  },
  {
    title: "Container memory",
    unit: "bytes",
    description:
      "Working set, which is what the OOM killer looks at — so this against a pod's limit is the answer to why it was killed.",
    targets: [
      [
        'sum by (node, pod) (container_memory_working_set_bytes{pod!=""})',
        "{{node}} {{pod}}",
      ],
    ],
  },
  {
    title: "Container CPU",
    description: "Cores. Compare against the pod's limit before raising it.",
    targets: [
      [
        'sum by (node, pod) (rate(container_cpu_usage_seconds_total{pod!=""}[$__rate_interval]))',
        "{{node}} {{pod}}",
      ],
    ],
  },
]);

const edge = dashboard("jaritanet-edge", "Ingress and policy", [
  {
    title: "Dropped packets by reason",
    description:
      '`POLICY_DENIED` is a NetworkPolicy actually refusing something. Empty means nothing was dropped, or that Hubble metrics are off — check `up{job="hubble"}`.',
    targets: [
      [
        "sum by (reason) (rate(hubble_drop_total[$__rate_interval]))",
        "{{reason}}",
      ],
    ],
  },
  {
    title: "Flow verdicts",
    targets: [
      [
        "sum by (verdict) (rate(hubble_flows_processed_total[$__rate_interval]))",
        "{{verdict}}",
      ],
    ],
  },
  {
    title: "Requests by route",
    unit: "reqps",
    targets: [
      [
        "sum by (router) (rate(traefik_router_requests_total[$__rate_interval]))",
        "{{router}}",
      ],
    ],
  },
  {
    title: "Response codes",
    unit: "reqps",
    targets: [
      [
        "sum by (code) (rate(traefik_router_requests_total[$__rate_interval]))",
        "{{code}}",
      ],
    ],
  },
  {
    title: "Route latency (p95)",
    unit: "s",
    targets: [
      [
        "histogram_quantile(0.95, sum by (le, router) (rate(traefik_router_request_duration_seconds_bucket[$__rate_interval])))",
        "{{router}}",
      ],
    ],
  },
  {
    title: "Scrape targets up",
    max: 1,
    description:
      "A job at 0 is a collector that is not collecting — the failure that otherwise presents months later as an empty graph.",
    targets: [["min by (job, node) (up)", "{{node}} {{job}}"]],
  },
]);

/** Filename → dashboard JSON, as Grafana's file provisioner wants it. */
export function dashboardFiles() {
  return Object.fromEntries(
    [disks, nodes, edge].map((d) => [
      `${d.uid}.json`,
      JSON.stringify(d, null, 2),
    ]),
  );
}
