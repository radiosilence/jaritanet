import type { Deployed } from "@jaritanet/k8s";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { VERSIONS } from "./versions.ts";

/**
 * MCP over HTTP. It carries no credential check of its own, so the chart's
 * policy admits the gateway to it and nothing else.
 */
export const KOAN_INTERNAL_PORT = 8081;
const API_PORT = 4000;

/**
 * What each object was called before koan shipped its own chart, by kind and
 * name. Aliased so the move is an update in place: without it Pulumi would
 * create the chart's objects alongside the old ones, and the names collide.
 */
const PREVIOUS: Record<string, string> = {
  "kubernetes:apps/v1:Deployment/koan": "koan",
  "kubernetes:core/v1:Service/koan-service": "koan-service",
  "kubernetes:core/v1:Service/koan-internal": "koan-internal",
  "kubernetes:networking.k8s.io/v1:NetworkPolicy/koan": "koan-netpol",
};

/**
 * koan as a headless server over the media library, from the chart koan
 * publishes with each release: GraphQL and Subsonic at a hostname of its own,
 * and MCP for the gateway on an internal port.
 *
 * The library is mounted read-only; koan's config, index and auth keys live
 * in a state directory on the same node. Users and the Subsonic secret are
 * created with `koan auth setup` and `koan subsonic setup` inside the pod;
 * until then the public port refuses everything.
 */
export function createKoan(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  opts: {
    hostname: string;
    node: string;
    gatewayPodLabels?: Record<string, string>;
  },
): Deployed {
  new k8s.helm.v4.Chart(
    "koan",
    {
      chart: "oci://ghcr.io/radiosilence/charts/koan",
      version: VERSIONS.koanChart,
      namespace,
      values: {
        hostname: opts.hostname,
        library: { hostPath: "/mnt/kontent/music" },
        state: { hostPath: "/var/lib/koan" },
        nodeSelector: { "kubernetes.io/hostname": opts.node },
        // The route helper derives `<prefix>-service`, and the MCP gateway
        // is registered at koan-internal.
        service: { name: "koan-service" },
        mcp: { serviceName: "koan-internal" },
        networkPolicy: {
          mcp: {
            from: [
              {
                podSelector: {
                  matchLabels: opts.gatewayPodLabels ?? { app: "mcp-gateway" },
                },
              },
            ],
          },
          // The node, for the probes: this CNI enforces policy on kubelet.
          extraIngress: [
            {
              from: [{ ipBlock: { cidr: "192.168.0.0/16" } }],
              ports: [{ protocol: "TCP", port: API_PORT }],
            },
          ],
        },
      },
    },
    {
      provider,
      transforms: [
        ({ type, props, opts: resourceOpts }) => {
          const previous = PREVIOUS[`${type}/${props.metadata?.name}`];
          if (!previous) return undefined;
          return {
            props,
            opts: pulumi.mergeOptions(resourceOpts, {
              aliases: [pulumi.createUrn(previous, type)],
            }),
          };
        },
      ],
    },
  );

  // The route helper names the Service `${service}-service`.
  return { routes: [{ service: "koan", hostname: opts.hostname }] };
}
