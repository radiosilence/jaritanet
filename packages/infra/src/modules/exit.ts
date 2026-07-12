import * as crypto from "node:crypto";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import type * as z from "zod";
import type { ExitConfSchema } from "../conf.schemas.ts";

/**
 * A k8s egress exit: ss-rust in the home cluster. Traffic reaches it through
 * the rathole tunnel (a rathole client entry punches its port out to the
 * gateways — see ingress + gateway), and it NATs out via the pod's normal
 * egress — which the CNI SNATs to the node IP, i.e. the home link. No
 * `hostNetwork`, no kernel forwarding: ss-rust owns both ends of each flow.
 *
 * The ss password is a single Pulumi secret consumed here (server ConfigMap)
 * and by the client outbound (see singbox) — one source, no drift. Returns the
 * exit's coordinates for the rathole entries and the client profile.
 */
export function createExit(
  provider: k8s.Provider,
  namespace: string,
  exit: z.infer<typeof ExitConfSchema>,
) {
  const name = `exit-${exit.name}`;
  const password = new random.RandomPassword(`${name}-ss`, {
    length: 32,
    special: false,
  });

  const config = password.result.apply((pw) =>
    JSON.stringify({
      server: "0.0.0.0",
      server_port: exit.port,
      method: exit.method,
      password: pw,
      mode: "tcp_and_udp",
    }),
  );
  const configHash = config.apply((c) =>
    crypto.createHash("sha256").update(c).digest("hex"),
  );

  const configMap = new k8s.core.v1.ConfigMap(
    `${name}-config`,
    {
      metadata: { name, namespace },
      data: { "config.json": config },
    },
    { provider },
  );

  new k8s.apps.v1.Deployment(
    name,
    {
      metadata: { name, namespace },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: name } },
        template: {
          // Roll the pod when the ss config (password/method/port) changes.
          metadata: {
            annotations: { "jaritanet/config-hash": configHash },
            labels: { app: name },
          },
          spec: {
            containers: [
              {
                name: "ssserver",
                image: exit.image,
                command: ["ssserver", "-c", "/etc/shadowsocks/config.json"],
                volumeMounts: [
                  {
                    name: "config",
                    mountPath: "/etc/shadowsocks",
                    readOnly: true,
                  },
                ],
                resources: {
                  limits: { cpu: "500m", memory: "128Mi" },
                },
              },
            ],
            volumes: [{ name: "config", configMap: { name } }],
          },
        },
      },
    },
    { dependsOn: [configMap], provider },
  );

  const service = new k8s.core.v1.Service(
    name,
    {
      metadata: { name, namespace },
      spec: {
        selector: { app: name },
        ports: [
          { name: "ss-tcp", port: exit.port, protocol: "TCP" },
          { name: "ss-udp", port: exit.port, protocol: "UDP" },
        ],
      },
    },
    { provider },
  );

  const host = pulumi.interpolate`${service.metadata.name}.${namespace}.svc.cluster.local`;

  return {
    host,
    method: exit.method,
    name: exit.name,
    password: password.result,
    port: exit.port,
  };
}
