/**
 * The dashboards Grafana is provisioned with.
 *
 * Built here rather than pasted in as exported JSON so the panels stay
 * readable and the queries stay reviewable — an exported dashboard is several
 * thousand lines of editor state around a dozen expressions, and a diff on it
 * says nothing. Anything built in the UI on top of these is Grafana's own state
 * and lives in its volume; these four are rebuilt from the ConfigMap on every
 * start, which is what makes them safe to change here.
 */

/** Fixed in the provisioned datasource, so panels can name it. */
export const DATASOURCE_UID = "victoriametrics";

/**
 * What Grafana opens on, in place of its own onboarding page.
 *
 * A triage page rather than a subsystem: the three others each answer "how is
 * this part doing", and none of them answers "is anything wrong". Exported so
 * the env var naming the file and the dashboard that file holds are one string
 * rather than two that agree today.
 */
export const HOME_DASHBOARD = "jaritanet-overview";

type Panel = {
  title: string;
  /** Grafana unit id — `bytes`, `Bps`, `percent`, `percentunit`, `s`, `reqps`. */
  unit?: string;
  description?: string;
  max?: number;
  /**
   * More series than a screen has room to name — one per pod, one per route.
   *
   * The table legend below is worth its space on a panel with two lines on it:
   * current and peak, per node, right there. On a panel with thirty it is a
   * scrolling table taller than the graph it belongs to, and on a phone, where
   * every panel is full width and read one at a time, it is the whole screen.
   * Those get a plain list and a single-series tooltip instead.
   */
  busy?: boolean;
  /** `[expression, legend]`, in query order. */
  targets: [string, string][];
};

/**
 * A single number, coloured by whether it is fine.
 *
 * The answer to "is anything fucked" is a colour, not a graph — a graph is what
 * you read once the colour says to. Each of these is a worst-of across the
 * estate, so one glance covers every disk or every container rather than
 * needing the right series to be picked out of a legend first.
 *
 * `topk(1, …)` rather than `max(…)` deliberately: `max` drops the labels, and
 * the useful half of the answer is *which* disk is full. The identity can flip
 * between scrapes when two are neck and neck, which is correct for a panel
 * whose question is "worst, right now".
 */
type Stat = {
  title: string;
  description?: string;
  unit?: string;
  /** `[expression, legend]` — the legend names what the number belongs to. */
  target: [string, string];
  /** `[amber, red]`: where it stops being fine, and where it is a problem. */
  thresholds: [number, number];
  /**
   * For a number where *less* is worse — time left on a certificate, not
   * percent of a disk used. The thresholds stay ascending, which is what
   * Grafana requires; only the colours run the other way.
   */
  invert?: boolean;
};

const STAT_HEIGHT = 4;

/**
 * Two panels per row, eight rows high, in declaration order, under a row of
 * stats if there are any.
 *
 * `$__rate_interval` rather than a fixed window: Grafana sizes it from the
 * panel's own resolution and the scrape interval, so a zoomed-out panel does
 * not average a spike into nothing and a zoomed-in one still has samples to
 * work with.
 */
function dashboard(
  uid: string,
  title: string,
  panels: Panel[],
  stats: Stat[] = [],
) {
  const top = stats.length ? STAT_HEIGHT : 0;
  return {
    uid,
    title,
    tags: ["jaritanet"],
    timezone: "browser",
    schemaVersion: 41,
    refresh: "1m",
    time: { from: "now-24h", to: "now" },
    panels: [
      ...stats.map((stat, i) => ({
        type: "stat",
        id: 100 + i,
        title: stat.title,
        ...(stat.description && { description: stat.description }),
        gridPos: {
          h: STAT_HEIGHT,
          w: Math.floor(24 / stats.length),
          x: i * Math.floor(24 / stats.length),
          y: 0,
        },
        datasource: { type: "prometheus", uid: DATASOURCE_UID },
        fieldConfig: {
          defaults: {
            unit: stat.unit ?? "short",
            decimals: 0,
            mappings: [],
            thresholds: {
              mode: "absolute",
              steps: [
                { color: stat.invert ? "red" : "green", value: null },
                { color: "orange", value: stat.thresholds[0] },
                {
                  color: stat.invert ? "green" : "red",
                  value: stat.thresholds[1],
                },
              ],
            },
          },
          overrides: [],
        },
        options: {
          reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
          // The whole tile takes the colour, so the page answers from across
          // the room rather than needing a number to be read.
          colorMode: "background",
          graphMode: "area",
          // Names the series beside the number — which disk, which container.
          textMode: "value_and_name",
        },
        targets: [
          { expr: stat.target[0], legendFormat: stat.target[1], refId: "A" },
        ],
      })),
      ...panels.map((panel, i) => ({
        type: "timeseries",
        id: i + 1,
        title: panel.title,
        ...(panel.description && { description: panel.description }),
        gridPos: {
          h: 8,
          w: 12,
          x: (i % 2) * 12,
          y: top + Math.floor(i / 2) * 8,
        },
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
          legend: panel.busy
            ? { displayMode: "list", placement: "bottom" }
            : {
                displayMode: "table",
                placement: "bottom",
                calcs: ["lastNotNull", "max"],
              },
          tooltip: panel.busy
            ? { mode: "single" }
            : { mode: "multi", sort: "desc" },
        },
        targets: panel.targets.map(([expr, legendFormat], n) => ({
          expr,
          legendFormat,
          refId: String.fromCharCode(65 + n),
        })),
      })),
    ],
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

/**
 * How full a filesystem is, as a percentage.
 *
 * Shared between the overview's stat and the Disks graph, because the number
 * on the landing page and the number you click through to had better be the
 * same one.
 */
const USED_PERCENT = () =>
  `100 - (node_filesystem_avail_bytes{${REAL_FS}} / node_filesystem_size_bytes{${REAL_FS}} * 100)`;

/**
 * A container's memory as a share of the ceiling it is allowed.
 *
 * `> 0` on the denominator is load-bearing rather than defensive: a container
 * with no limit reports one of zero, and dividing by it yields +Inf, which
 * sorts above every real value and would make it the permanent answer to
 * "what is closest to being killed".
 *
 * `container!=""` is the other half. cAdvisor reports each container *and* the
 * pod-level cgroup that holds them, under the same `pod` label — so every pod
 * appears twice, and anything summed by pod counts it twice. Measured here: 55
 * series where there are 30 containers.
 */
const REAL_CONTAINER = 'pod!="",container!=""';

const MEMORY_HEADROOM = `container_memory_working_set_bytes{${REAL_CONTAINER}} / (container_spec_memory_limit_bytes{${REAL_CONTAINER}} > 0)`;

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
    busy: true,
    unit: "bytes",
    description:
      "Working set, which is what the OOM killer looks at — so this against a pod's limit is the answer to why it was killed.",
    targets: [
      [
        `sum by (node, pod) (container_memory_working_set_bytes{${REAL_CONTAINER}})`,
        "{{node}} {{pod}}",
      ],
    ],
  },
  {
    title: "Container CPU",
    busy: true,
    description: "Cores. Compare against the pod's limit before raising it.",
    targets: [
      [
        `sum by (node, pod) (rate(container_cpu_usage_seconds_total{${REAL_CONTAINER}}[$__rate_interval]))`,
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
    busy: true,
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
    busy: true,
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
    busy: true,
    max: 1,
    description:
      "A job at 0 is a collector that is not collecting — the failure that otherwise presents months later as an empty graph.",
    targets: [["min by (job, node) (up)", "{{node}} {{job}}"]],
  },
]);

/**
 * The page you open when something feels wrong, and the only one you should
 * need to open.
 *
 * The other three are per-subsystem: each answers "how is this part doing",
 * and none answers "is anything wrong". This one is picked from where this
 * estate actually breaks, which is a short and well-evidenced list — mechanical
 * disks in USB enclosures, memory ceilings that have already killed things
 * (#166/#168), a residential uplink carrying pod traffic, a certificate that
 * renews itself or silently does not, and NetworkPolicies that were decorative
 * under flannel and have never been verified under Cilium.
 *
 * The stat row is the whole point: six numbers, each the worst case across the
 * estate, each naming what it belongs to. A red tile says which disk, which
 * pod. The graphs below are for after a tile has told you where to look.
 */
const overview = dashboard(
  HOME_DASHBOARD,
  "Overview",
  [
    {
      title: "Filesystem used",
      unit: "percent",
      max: 100,
      description:
        "Keyed on mountpoint, so it survives the externals being replugged in a different order.",
      targets: [[USED_PERCENT(), "{{node}} {{mountpoint}}"]],
    },
    {
      title: "Disk utilisation",
      unit: "percentunit",
      description: `Share of wall-clock time the device spent servicing IO. Sustained near 1 on the media drive is the usual answer to why streaming stutters — a mechanical disk in a USB enclosure runs out of seeks long before it runs out of bandwidth. ${DEVICE_LABEL_CAVEAT}`,
      targets: [
        [
          "rate(node_disk_io_time_seconds_total[$__rate_interval])",
          "{{node}} {{device}}",
        ],
      ],
    },
    {
      title: "Container CPU",
      busy: true,
      description:
        "Cores. Navidrome transcoding is CPU-bound, so this is the other half of why a stream stutters — and the gateway has four cores for the whole estate.",
      targets: [
        [
          `sum by (node, pod) (rate(container_cpu_usage_seconds_total{${REAL_CONTAINER}}[$__rate_interval]))`,
          "{{node}} {{pod}}",
        ],
      ],
    },
    {
      title: "Container memory against its limit",
      busy: true,
      unit: "percentunit",
      max: 1,
      description:
        "1 is the OOM killer. Working set is what it looks at, and the limit is what it compares against, so this is the graph that explains a pod that vanished.",
      targets: [[MEMORY_HEADROOM, "{{pod}} {{container}}"]],
    },
    {
      title: "Container restarts",
      busy: true,
      description:
        "A spike is a container that died. Derived from its start time changing — there is no kube-state-metrics here, so this is the restart counter.",
      targets: [
        [
          `sum by (pod) (changes(container_start_time_seconds{${REAL_CONTAINER}}[$__rate_interval]))`,
          "{{pod}}",
        ],
      ],
    },
    {
      title: "Route latency (p95)",
      busy: true,
      unit: "s",
      description:
        "Per published hostname, measured at Traefik. Slow here with idle disks and idle CPU means the hop between the two machines, not the service.",
      targets: [
        [
          "histogram_quantile(0.95, sum by (le, router) (rate(traefik_router_request_duration_seconds_bucket[$__rate_interval])))",
          "{{router}}",
        ],
      ],
    },
    {
      title: "Collectors reporting",
      description:
        "How many scrape targets each machine is answering — seven or so each. The home box dropping to nothing is the tailnet going away, which the tiles above cannot show: a machine that stops reporting has no failing target, it has no target at all.",
      targets: [["count by (node) (up == 1)", "{{node}}"]],
    },
  ],
  [
    {
      title: "Fullest disk",
      unit: "percent",
      description: "Worst mountpoint across both machines, right now.",
      target: [`topk(1, ${USED_PERCENT()})`, "{{node}} {{mountpoint}}"],
      thresholds: [80, 90],
    },
    {
      title: "Busiest disk",
      unit: "percentunit",
      description:
        "Worst device. Near 1 means it is saturated on seeks, which is what a stalled stream or a slow scan looks like from here.",
      target: [
        "topk(1, rate(node_disk_io_time_seconds_total[$__rate_interval]))",
        "{{node}} {{device}}",
      ],
      thresholds: [0.8, 0.95],
    },
    {
      title: "Closest to its limit",
      unit: "percentunit",
      description:
        "The container nearest being OOM-killed. Both of the ones that have been killed here got there this way.",
      target: [`topk(1, ${MEMORY_HEADROOM})`, "{{pod}} {{container}}"],
      thresholds: [0.8, 0.95],
    },
    {
      title: "Collectors down",
      description:
        "Scrape targets answering nothing. Anything but zero means part of the estate is unmeasured, so every other tile is quieter than the truth.",
      target: ["count(up == 0) or vector(0)", "targets"],
      thresholds: [1, 2],
    },
    {
      title: "Certificate renews in",
      unit: "s",
      invert: true,
      description:
        "Time left on the nearest certificate. Let's Encrypt renews at 30 days, so this counting down past a week means the DNS-01 challenge is failing and every hostname goes at once. Blank means Traefik has served no certificate yet.",
      target: ["min(traefik_tls_certs_not_after) - time()", "nearest"],
      thresholds: [7 * 24 * 3600, 21 * 24 * 3600],
    },
    {
      title: "Policy drops",
      description:
        "Packets refused by a NetworkPolicy, per second. These were decorative under flannel and are enforced under Cilium, so a rule that is wrong shows up here rather than as a service that is mysteriously broken.",
      target: [
        'sum(rate(hubble_drop_total{reason="POLICY_DENIED"}[$__rate_interval])) or vector(0)',
        "denied",
      ],
      thresholds: [0.1, 1],
    },
  ],
);

/** Filename → dashboard JSON, as Grafana's file provisioner wants it. */
export function dashboardFiles() {
  return Object.fromEntries(
    [overview, disks, nodes, edge].map((d) => [
      `${d.uid}.json`,
      JSON.stringify(d, null, 2),
    ]),
  );
}
