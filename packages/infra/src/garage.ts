import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

/**
 * Garage, the S3-compatible object store, pinned by hand: its releases are
 * published on its own forge, not on GitHub, where the updater reads them.
 */
const IMAGE = "docker.io/dxflrs/garage:v2.5.0";
/** Floats, as the metrics package's init containers do: one `chown`. */
const BUSYBOX = "docker.io/library/busybox:1.38";

const NAME = "garage";
const S3_PORT = 3900;
const ADMIN_PORT = 3903;
/** jc, who owns the media pool on the node. */
const UID = 1000;
/** The only region Garage answers to; clients must name it. */
const REGION = "garage";

export type GarageArgs = {
  /** The node whose disk holds it, by hostname. */
  node: string;
  /** Where on that node its data and metadata live. */
  path: string;
  /** The bucket made on its first start, with the key it returns. */
  bucket: string;
  /** Pods that may reach its S3 API, by their labels. */
  clients: Record<string, string>[];
};

/**
 * One Garage node holding one copy of each object: the disk under it is the
 * redundancy (the media pool is btrfs RAID1). It makes its single-node layout,
 * its bucket and the key for it on first start, from the configuration and
 * the environment, so nothing needs a shell its image does not have.
 *
 * Its S3 API is reachable from the client pods named and nothing else; it
 * reaches nothing itself. The admin API answers only the kubelet's probe.
 */
export function createGarage(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  args: GarageArgs,
) {
  const options = { provider };
  const labels = { app: NAME };
  const secretRef = (key: string) => ({
    valueFrom: { secretKeyRef: { name: `${NAME}-secrets`, key } },
  });

  // Formats from Garage's quick start: an RPC secret of 32 bytes in hex, and
  // a key whose id is "GK" and 16 bytes in hex, its secret 32 bytes in hex.
  const rpcSecret = new random.RandomId(`${NAME}-rpc-secret`, {
    byteLength: 32,
  }).hex;
  const adminToken = new random.RandomPassword(`${NAME}-admin-token`, {
    length: 48,
    special: false,
  }).result;
  const accessKeyId = pulumi.interpolate`GK${new random.RandomId(`${NAME}-key-id`, { byteLength: 16 }).hex}`;
  const secretAccessKey = pulumi.secret(
    new random.RandomId(`${NAME}-key-secret`, { byteLength: 32 }).hex,
  );

  const secret = new k8s.core.v1.Secret(
    `${NAME}-secrets`,
    {
      metadata: { name: `${NAME}-secrets`, namespace },
      stringData: {
        "rpc-secret": pulumi.secret(rpcSecret),
        "admin-token": adminToken,
        "access-key-id": accessKeyId,
        "secret-access-key": secretAccessKey,
      },
    },
    options,
  );

  // SQLite rather than LMDB: Garage's notes say LMDB can be corrupted by an
  // unclean shutdown, which a node at home sees.
  const config = new k8s.core.v1.ConfigMap(
    `${NAME}-config`,
    {
      metadata: { name: `${NAME}-config`, namespace },
      data: {
        "garage.toml": [
          `metadata_dir = "/var/lib/garage/meta"`,
          `data_dir = "/var/lib/garage/data"`,
          `db_engine = "sqlite"`,
          `replication_factor = 1`,
          `rpc_bind_addr = "[::]:3901"`,
          `rpc_public_addr = "127.0.0.1:3901"`,
          ``,
          `[s3_api]`,
          `api_bind_addr = "[::]:${S3_PORT}"`,
          `s3_region = "${REGION}"`,
          ``,
          `[admin]`,
          `api_bind_addr = "[::]:${ADMIN_PORT}"`,
          ``,
        ].join("\n"),
      },
    },
    options,
  );

  new k8s.apps.v1.Deployment(
    NAME,
    {
      metadata: { name: NAME, namespace, labels },
      spec: {
        replicas: 1,
        // One node's data directory: a second pod would be a second node.
        strategy: { type: "Recreate" },
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            nodeSelector: { "kubernetes.io/hostname": args.node },
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: UID,
              runAsGroup: UID,
              seccompProfile: { type: "RuntimeDefault" },
            },
            // kubelet creates a missing hostPath as root; this hands it over.
            initContainers: [
              {
                name: "own",
                image: BUSYBOX,
                command: [
                  "sh",
                  "-c",
                  `chown ${UID}:${UID} /data && chmod 700 /data`,
                ],
                securityContext: {
                  runAsUser: 0,
                  runAsNonRoot: false,
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"], add: ["CHOWN", "FOWNER"] },
                },
                resources: {
                  requests: { cpu: "5m", memory: "8Mi" },
                  limits: { memory: "32Mi" },
                },
                volumeMounts: [{ name: "data", mountPath: "/data" }],
              },
            ],
            containers: [
              {
                name: NAME,
                image: IMAGE,
                imagePullPolicy: "IfNotPresent",
                // Lays out a single node, and makes the default bucket and key
                // from the environment, when they are not there yet.
                command: [
                  "/garage",
                  "server",
                  "--single-node",
                  "--default-bucket",
                ],
                env: [
                  {
                    name: "GARAGE_CONFIG_FILE",
                    value: "/etc/garage/garage.toml",
                  },
                  { name: "GARAGE_RPC_SECRET", ...secretRef("rpc-secret") },
                  { name: "GARAGE_ADMIN_TOKEN", ...secretRef("admin-token") },
                  { name: "GARAGE_DEFAULT_BUCKET", value: args.bucket },
                  {
                    name: "GARAGE_DEFAULT_ACCESS_KEY",
                    ...secretRef("access-key-id"),
                  },
                  {
                    name: "GARAGE_DEFAULT_SECRET_KEY",
                    ...secretRef("secret-access-key"),
                  },
                  { name: "RUST_LOG", value: "garage=info" },
                ],
                ports: [
                  { name: "s3", containerPort: S3_PORT },
                  { name: "admin", containerPort: ADMIN_PORT },
                ],
                readinessProbe: {
                  httpGet: { path: "/health", port: "admin" },
                  periodSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: "/health", port: "admin" },
                  initialDelaySeconds: 20,
                  periodSeconds: 30,
                },
                resources: {
                  limits: { cpu: "1", memory: "512Mi" },
                  requests: { cpu: "10m", memory: "64Mi" },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
                volumeMounts: [
                  { name: "config", mountPath: "/etc/garage", readOnly: true },
                  { name: "data", mountPath: "/var/lib/garage" },
                ],
              },
            ],
            volumes: [
              { name: "config", configMap: { name: config.metadata.name } },
              {
                name: "data",
                hostPath: { path: args.path, type: "DirectoryOrCreate" },
              },
            ],
          },
        },
      },
    },
    { ...options, dependsOn: [secret, config] },
  );

  new k8s.core.v1.Service(
    NAME,
    {
      metadata: { name: NAME, namespace },
      spec: {
        selector: labels,
        ports: [{ name: "s3", port: S3_PORT, targetPort: S3_PORT }],
      },
    },
    options,
  );

  // Ingress names its clients; egress names nothing, since one node talks
  // only to itself. The kubelet's probes are not subject to either.
  new k8s.networking.v1.NetworkPolicy(
    `${NAME}-netpol`,
    {
      metadata: { name: NAME, namespace },
      spec: {
        podSelector: { matchLabels: labels },
        policyTypes: ["Ingress", "Egress"],
        ingress: [
          {
            from: args.clients.map((matchLabels) => ({
              podSelector: { matchLabels },
            })),
            ports: [{ protocol: "TCP", port: S3_PORT }],
          },
        ],
        egress: [],
      },
    },
    options,
  );

  return {
    // By the Service's name, which resolves in its own namespace: where its
    // clients are.
    endpoint: `http://${NAME}:${S3_PORT}`,
    region: REGION,
    bucket: args.bucket,
    accessKeyId,
    secretAccessKey,
    peer: { podLabels: labels, port: S3_PORT },
  };
}
