import * as k8s from "@pulumi/kubernetes";
import type * as z from "zod";
import type { HealthCheckConfigSchema } from "./healthcheck.schemas.ts";
import { ServiceArgsSchema } from "./service.schemas.ts";

const annotations = {
  "pulumi.com/skipAwait": "false",
};

// A k8s httpGet probe from the health-check config. Liveness/readiness/startup
// share the same shape; startup passes a larger failureThreshold to tolerate a
// slow first boot.
const probe = (
  hc: z.infer<typeof HealthCheckConfigSchema>,
  httpPort: number,
  failureThreshold = hc.failureThreshold,
) => ({
  httpGet: {
    path: hc.path,
    port: hc.port ?? httpPort,
    ...(hc.httpHeaders.length > 0 && { httpHeaders: hc.httpHeaders }),
  },
  initialDelaySeconds: hc.initialDelaySeconds,
  periodSeconds: hc.periodSeconds,
  timeoutSeconds: hc.timeoutSeconds,
  failureThreshold,
  successThreshold: hc.successThreshold,
});

/**
 * What a caller writes, before defaults. The parse happens here rather than at
 * a config boundary, so a service is declared by passing the handful of fields
 * it actually differs on — the other thirty defaults stay stated once, in the
 * schema, instead of being reproduced at every call site.
 */
export type ServiceArgs = z.input<typeof ServiceArgsSchema>;

export function createService(
  provider: k8s.Provider,
  serviceName: string,
  args: ServiceArgs,
) {
  const {
    env,
    healthCheck,
    httpPort,
    image,
    resources,
    networkPolicy,
    persistence,
    replicas,
    restrictIngress,
    strategy,
  } = ServiceArgsSchema.parse(args);
  // These volumes are host directories holding real data (the music library
  // among them), so nothing may ever delete one: Retain stops Kubernetes
  // reclaiming a released volume, and retainOnDelete stops Pulumi deleting the
  // objects when a service is removed from code. Clearing one out is a manual,
  // deliberate act on the host.
  const pvs = Object.fromEntries(
    persistence.map(
      ({
        name: key,
        storageClassName,
        readOnly,
        storage,
        nodeAffinityHostname,
        hostPath,
      }) => [
        key,
        new k8s.core.v1.PersistentVolume(
          `${serviceName}-${key}-pv`,
          {
            metadata: {
              annotations,
            },
            spec: {
              accessModes: readOnly ? ["ReadOnlyMany"] : ["ReadWriteMany"],
              capacity: {
                storage,
              },
              local: {
                path: hostPath,
              },
              nodeAffinity: {
                required: {
                  nodeSelectorTerms: [
                    {
                      matchExpressions: [
                        {
                          key: "kubernetes.io/hostname",
                          operator: "In",
                          values: [nodeAffinityHostname],
                        },
                      ],
                    },
                  ],
                },
              },
              persistentVolumeReclaimPolicy: "Retain",
              storageClassName,
              volumeMode: "Filesystem",
            },
          },
          { provider, retainOnDelete: true },
        ),
      ],
    ),
  );

  const pvcs = Object.fromEntries(
    persistence.map(({ name: key, storageClassName, readOnly, storage }) => [
      key,
      new k8s.core.v1.PersistentVolumeClaim(
        `${serviceName}-${key}-pvc`,
        {
          metadata: {
            annotations,
          },
          spec: {
            accessModes: readOnly ? ["ReadOnlyMany"] : ["ReadWriteMany"],
            resources: { requests: { storage } },
            storageClassName,
            volumeName: pvs[key]?.metadata.name,
          },
        },
        { provider, retainOnDelete: true },
      ),
    ]),
  );

  const service = new k8s.core.v1.Service(
    `${serviceName}-service`,
    {
      metadata: {
        annotations,
        name: `${serviceName}-service`,
      },
      spec: {
        ports: [
          {
            protocol: "TCP",
            port: 80,
            targetPort: httpPort,
          },
        ],
        selector: { app: serviceName },
      },
    },
    { provider },
  );

  const probes = healthCheck
    ? {
        ...(healthCheck.enableLiveness && {
          livenessProbe: probe(healthCheck, httpPort),
        }),
        ...(healthCheck.enableReadiness && {
          readinessProbe: probe(healthCheck, httpPort),
        }),
        // Startup gets 3× the failure budget (min 30) so a cold boot isn't
        // killed before it's ready.
        ...(healthCheck.enableStartup && {
          startupProbe: probe(
            healthCheck,
            httpPort,
            Math.max(healthCheck.failureThreshold * 3, 30),
          ),
        }),
      }
    : {};

  new k8s.apps.v1.Deployment(
    `${serviceName}-deployment`,
    {
      metadata: {
        annotations,
      },
      spec: {
        replicas,
        selector: {
          matchLabels: { app: serviceName },
        },
        strategy,
        template: {
          metadata: {
            annotations,
            labels: { app: serviceName },
          },
          spec: {
            // None of these talk to the API server, so the token is a free
            // foothold for anything that lands in the container.
            automountServiceAccountToken: false,
            containers: [
              {
                name: serviceName,
                image: `${image.repository}:${image.tag}`,
                imagePullPolicy: image.pullPolicy,
                ports: [{ name: "http", containerPort: httpPort }],
                resources,
                // Sorted, so the rendered order is a property of the names
                // rather than of how they happened to be written. Pulumi used
                // to sort these on the way out of stack config, which meant
                // reordering a literal now churns the Deployment for nothing.
                env: Object.entries(env)
                  .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                  .map(([name, value]) => ({ name, value })),
                volumeMounts: persistence.map(
                  ({ name, mountPath, readOnly }) => ({
                    name,
                    mountPath,
                    readOnly,
                  }),
                ),
                ...probes,
                securityContext: {
                  allowPrivilegeEscalation: false,
                  seccompProfile: { type: "RuntimeDefault" },
                },
              },
            ],
            volumes: Object.entries(pvcs).map(([name, pvc]) => ({
              name,
              persistentVolumeClaim: { claimName: pvc.metadata.name },
            })),
          },
        },
      },
    },
    { deleteBeforeReplace: persistence.length > 0, provider },
  );

  // Egress only — see `networkPolicy` in the schema for why ingress is left
  // alone. DNS needs its own rule because the cluster resolver's ClusterIP
  // sits inside the private space the second rule excludes; policy rules are
  // OR'd, so the narrow allow survives the broad deny.
  if (networkPolicy) {
    new k8s.networking.v1.NetworkPolicy(
      `${serviceName}-netpol`,
      {
        metadata: { name: serviceName },
        spec: {
          podSelector: { matchLabels: { app: serviceName } },
          policyTypes: restrictIngress ? ["Ingress", "Egress"] : ["Egress"],
          ...(restrictIngress && {
            ingress: [
              {
                from: [
                  // The only intended caller.
                  {
                    podSelector: {
                      matchLabels: { "app.kubernetes.io/name": "traefik" },
                    },
                  },
                  // The kubelet's probes come from the node, not from a pod, so
                  // without this the pod fails readiness and gets killed. Pod
                  // IPs are 10.1.x, so allowing the node's LAN still shuts out
                  // every sibling — which is the whole point of the rule.
                  { ipBlock: { cidr: "192.168.0.0/16" } },
                ],
              },
            ],
          }),
          egress: [
            {
              to: [
                {
                  namespaceSelector: {
                    matchLabels: {
                      "kubernetes.io/metadata.name": "kube-system",
                    },
                  },
                },
              ],
              ports: [
                { protocol: "UDP", port: 53 },
                { protocol: "TCP", port: 53 },
              ],
            },
            {
              to: [
                {
                  ipBlock: {
                    cidr: "0.0.0.0/0",
                    except: [
                      "10.0.0.0/8", // pod + service CIDRs, and any LAN using it
                      "172.16.0.0/12",
                      "192.168.0.0/16", // the node's own LAN
                      "169.254.0.0/16",
                      "100.64.0.0/10", // tailnet
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
      { provider },
    );
  }

  return service;
}
