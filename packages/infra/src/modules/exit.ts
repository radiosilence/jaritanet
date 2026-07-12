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
      // TCP only: the rathole tunnel that reaches this server is TCP, so UDP
      // associations can't traverse the exit path (UDP goes direct instead).
      mode: "tcp_only",
    }),
  );
  const configHash = config.apply((c) =>
    crypto.createHash("sha256").update(c).digest("hex"),
  );

  // Secret, not ConfigMap: config.json embeds the ss password in cleartext.
  const secret = new k8s.core.v1.Secret(
    `${name}-config`,
    {
      metadata: { name, namespace },
      stringData: { "config.json": config },
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
            volumes: [{ name: "config", secret: { secretName: name } }],
          },
        },
      },
    },
    { dependsOn: [secret], provider },
  );

  const service = new k8s.core.v1.Service(
    name,
    {
      metadata: { name, namespace },
      spec: {
        selector: { app: name },
        ports: [{ name: "ss-tcp", port: exit.port, protocol: "TCP" }],
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
