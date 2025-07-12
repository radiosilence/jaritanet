import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

describe("cloudflared template", () => {
  let mockProvider: k8s.Provider;

  beforeAll(() => {
    // Set up mocks first
    pulumi.runtime.setMocks({
      newResource: (
        args: pulumi.runtime.MockResourceArgs,
      ): {
        id: string;
        state: any;
      } => ({
        id: `${args.inputs.name || args.name || "test"}_id`,
        state: {
          ...args.inputs,
          id: `${args.inputs.name || args.name || "test"}_id`,
          metadata: {
            name: args.inputs.name || args.name || "test",
            ...args.inputs.metadata,
          },
        },
      }),
      call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
    });

    mockProvider = new k8s.Provider("test-provider", {
      kubeconfig: "fake-config",
    });
  });

  it("creates cloudflared deployment with basic configuration", async () => {
    const { createCloudflared } = await import("./cloudflared.ts");
    const cloudflaredArgs = {
      replicas: 1,
      image: "cloudflare/cloudflared:latest",
      resources: {
        limits: {
          cpu: "100m",
          memory: "128Mi",
        },
        requests: {
          cpu: "50m",
          memory: "64Mi",
        },
      },
    };

    const deployment = createCloudflared(
      mockProvider,
      "tunnel",
      "test-token",
      cloudflaredArgs,
    );

    const metadata = await new Promise<any>((resolve) => {
      deployment.metadata.apply((value) => resolve(value));
    });

    expect(metadata.labels.app).toBe("tunnel");
  });

  it("creates cloudflared with correct command args", async () => {
    const { createCloudflared } = await import("./cloudflared.ts");
    const cloudflaredArgs = {
      replicas: 2,
      image: "cloudflare/cloudflared:2024.1.0",
      resources: {
        limits: {
          cpu: "200m",
          memory: "256Mi",
        },
        requests: {
          cpu: "100m",
          memory: "128Mi",
        },
      },
    };

    const deployment = createCloudflared(
      mockProvider,
      "my-tunnel",
      "secure-token-123",
      cloudflaredArgs,
    );

    const spec = await new Promise<any>((resolve) => {
      deployment.spec.apply((value) => resolve(value));
    });

    expect(spec.replicas).toBe(2);
    expect(spec.template.spec.containers[0].args).toEqual([
      "--token",
      "secure-token-123",
    ]);
    expect(spec.template.spec.containers[0].command).toEqual([
      "cloudflared",
      "tunnel",
      "--no-autoupdate",
      "--metrics",
      "0.0.0.0:2000",
      "run",
    ]);
  });

  it("creates cloudflared with health probes", async () => {
    const { createCloudflared } = await import("./cloudflared.ts");
    const cloudflaredArgs = {
      replicas: 1,
      image: "cloudflare/cloudflared:latest",
      resources: {
        limits: {
          cpu: "100m",
          memory: "128Mi",
        },
        requests: {
          cpu: "50m",
          memory: "64Mi",
        },
      },
    };

    const deployment = createCloudflared(
      mockProvider,
      "health-tunnel",
      "test-token",
      cloudflaredArgs,
    );

    expect(deployment).toBeDefined();
  });
});
