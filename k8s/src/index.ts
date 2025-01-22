import { z } from "zod";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import {
  type CloudflaredConf,
  CloudflaredConfSchema,
  ServicesArraySchema,
} from "./conf.schemas";
import { getKubeconfig } from "./kubeconfig";
import { outputDetailsSecret, TunnelSchema } from "./references.schemas";
import { createCloudflared, createService } from "./templates";
import { parse } from "@schema-hub/zod-error-formatter";

// Environment validation schema
const EnvSchema = z.object({
  KUBE_HOST: z.string().min(1, "KUBE_HOST is required"),
  KUBE_API_PORT: z.string().min(1, "KUBE_API_PORT is required"),
  KUBE_TOKEN: z.string().min(1, "KUBE_TOKEN is required"),
});

const config = new pulumi.Config();
const namespace = "jaritanet";

// Validate environment variables
const env = parse(EnvSchema, process.env);

const kubeconfig = JSON.stringify(
  getKubeconfig({
    host: env.KUBE_HOST,
    port: env.KUBE_API_PORT,
    token: atob(env.KUBE_TOKEN),
  }),
  null,
  2,
);

// Initialize Kubernetes provider with retry logic
const provider = new k8s.Provider(
  "provider",
  {
    kubeconfig,
    namespace,
  },
  {
    customTimeouts: {
      create: "5m",
      update: "5m",
      delete: "5m",
    },
  },
);

new k8s.core.v1.Namespace(
  namespace,
  {
    metadata: {
      name: namespace,
      labels: {
        name: namespace,
        "kubernetes.io/metadata.name": namespace,
      },
      annotations: {
        "pulumi.com/managed-by": "jaritanet",
      },
    },
  },
  { provider },
);

const infraStackRef = new pulumi.StackReference(
  `radiosilence/jaritanet/${pulumi.getStack()}`,
);

export = async () => {
  const services = parse(
    ServicesArraySchema,
    config.requireObject("services"),
  ).map(({ name, args, hostname, proxied }) => {
    const service = createService(provider, name, args);

    return {
      hostname,
      proxied,
      service: pulumi.interpolate`http://${service.metadata.name}.${namespace}.svc.cluster.local`,
    };
  });

  const { secretValue: tunnel } = parse(
    outputDetailsSecret(TunnelSchema),
    await infraStackRef.getOutputDetails("tunnel"),
  );

  const cloudflaredConf = parse(
    CloudflaredConfSchema,
    config.requireObject<CloudflaredConf>("cloudflared"),
  );

  // Create cloudflared deployment with proper error handling
  const cloudflared = createCloudflared(
    provider,
    cloudflaredConf.name,
    tunnel.tunnelToken,
    cloudflaredConf.args,
  );

  return {
    services,
    namespace,
    cloudflaredStatus: cloudflared.status,
  };
};
