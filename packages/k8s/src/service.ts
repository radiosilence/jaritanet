import * as k8s from "@pulumi/kubernetes";
import type * as z from "zod";
import type { HealthCheckConfigSchema } from "./healthcheck.schemas.ts";
import { ServiceArgsSchema } from "./service.schemas.ts";

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
          spec: {
            accessModes: readOnly ? ["ReadOnlyMany"] : ["ReadWriteMany"],
            resources: { requests: { storage } },
            storageClassName,
            volumeName: pvs[key].metadata.name,
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
      spec: {
        replicas,
        selector: {
          matchLabels: { app: serviceName },
        },
        strategy,
        template: {
          metadata: {
            labels: { app: serviceName },
          },
          spec: {
            // None of these talk to the API server, so the token is a free
            // foothold for anything that lands in the container.
            automountServiceAccountToken: false,
            // Never root: these are public web servers, and root in the
            // container is the first step of a kernel escape onto the node.
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 65534,
              runAsGroup: 65534,
              // Lets a non-root process bind a port below 1024 in the pod's own
              // network namespace, which is all a capability would have bought.
              ...(httpPort < 1024 && {
                sysctls: [
                  { name: "net.ipv4.ip_unprivileged_port_start", value: "0" },
                ],
              }),
            },
            containers: [
              {
                name: serviceName,
                image: `${image.repository}:${image.tag}`,
                imagePullPolicy: image.pullPolicy,
                ports: [{ name: "http", containerPort: httpPort }],
                resources,
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
                  capabilities: { drop: ["ALL"] },
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

  // An empty egress list under the Egress policy type denies every new outbound
  // connection; replies to the connections Traefik opens are still let through.
  // Ingress is restricted only on request; see `restrictIngress` for why.
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
                  // The only intended caller. Kubelet probes need no rule:
                  // Cilium admits the local host to its own endpoints.
                  {
                    podSelector: {
                      matchLabels: { "app.kubernetes.io/name": "traefik" },
                    },
                  },
                ],
              },
            ],
          }),
          egress: [],
        },
      },
      { provider },
    );
  }

  return service;
}
