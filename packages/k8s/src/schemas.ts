import * as z from "zod";

/**
 * Shapes that several packages check the same way.
 *
 * Each exists because getting it wrong fails somewhere far from the value: a
 * malformed hostname surfaces as a certificate that never issues, a label key
 * as a DaemonSet that schedules nothing onto a cluster reporting healthy, a
 * relative host path as a pod stuck Pending. Parsing catches all of those
 * before a single resource is touched.
 */

/** An RFC 1123 DNS name — what a certificate, an Ingress route and an SNI all need. */
export const Hostname = z
  .string()
  .regex(
    /^(?=.{1,253}$)[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)+$/,
    "must be a lowercase dotted hostname, e.g. music.example.com",
  );

/**
 * A `host:port` pair — what REALITY forwards an unmatched handshake to, and
 * what a relay target looks like. Either half being wrong makes the decoy fail
 * open, which is the failure this is worth catching early.
 */
export const HostPort = z
  .string()
  .regex(
    /^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*|\d{1,3}(\.\d{1,3}){3}):\d{1,5}$/,
    "must be host:port, e.g. www.example.com:443 or 127.0.0.1:8443",
  );

/** A TCP or UDP port. Zero is not one, and neither is 70000. */
export const Port = z.number().int().min(1).max(65535);

/** Absolute, because a container's working directory is not what you think. */
export const AbsolutePath = z
  .string()
  .startsWith("/", "must be an absolute path");

/**
 * A prefixed Kubernetes label key (`<dns-subdomain>/<name>`).
 *
 * A wrong-but-present value is caught by the next preview, since relabelling a
 * node is a visible diff. A malformed one is not: the selector matches nothing,
 * the workload schedules nowhere, and the cluster reports itself healthy.
 */
export const LabelKey = z
  .string()
  .regex(
    /^([a-z0-9]([-a-z0-9]*[a-z0-9])?\.)*[a-z0-9]([-a-z0-9]*[a-z0-9])?\/[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/,
    "must be a prefixed Kubernetes label key (<dns-subdomain>/<name>)",
  );

/** A Kubernetes resource quantity — `500m`, `2`, `64Mi`, `8Gi`. */
export const Quantity = z
  .string()
  .regex(
    /^\d+(\.\d+)?([munkMGTPE]|[KMGTPE]i)?$/,
    "must be a Kubernetes quantity, e.g. 500m, 2, 64Mi, 8Gi",
  );

export const HostVolumeSchema = z.object({
  hostPath: AbsolutePath,
  hostPathType: z
    .enum([
      "DirectoryOrCreate",
      "Directory",
      "FileOrCreate",
      "File",
      "Socket",
      "CharDevice",
      "BlockDevice",
    ])
    .default("Directory"),
  mountPath: AbsolutePath,
  name: z.string(),
  readOnly: z.boolean().default(true),
});

export const PersistenceSchema = z.object({
  hostPath: AbsolutePath,
  mountPath: AbsolutePath,
  name: z.string(),
  nodeAffinityHostname: z.string(),
  readOnly: z.boolean().default(true),
  storage: z.string(),
  storageClassName: z.string().default("local-storage"),
});

export const ImageSchema = z.object({
  pullPolicy: z.enum(["Always", "IfNotPresent", "Never"]).optional(),
  repository: z.string(),
  tag: z.string(),
});

export const LimitsSchema = z.object({
  cpu: Quantity.default("50m"),
  memory: Quantity.default("64Mi"),
});

export const StrategySchema = z.object({
  type: z.enum(["Recreate", "RollingUpdate"]).default("RollingUpdate"),
});

/**
 * Pod-level security context. Every field is optional and none is defaulted,
 * because setting one has consequences: `fsGroup` in particular switches on
 * kubelet volume ownership management, which walks and chowns the volume. On a
 * 2Ti media library backed by a `local` PV that is not a default anyone wants
 * to acquire by accident — so a service that only needs to run as a given uid
 * sets exactly that and nothing else.
 */
export const SecurityContextSchema = z.object({
  fsGroup: z.number().optional(),
  runAsGroup: z.number().optional(),
  runAsUser: z.number().optional(),
});
