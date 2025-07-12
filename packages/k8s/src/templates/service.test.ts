import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";
import { createService } from "./service.ts";

describe("service template", () => {
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

  it("creates service with basic configuration", async () => {
    const serviceArgs = {
      image: { repository: "nginx", tag: "latest" },
      replicas: 1,
      env: {},
      httpPort: 80,
      ports: [],
      hostVolumes: [],
      persistence: [],
    };

    const service = createService(mockProvider, "test-service", serviceArgs);

    const metadata = await new Promise<any>((resolve) => {
      service.metadata.apply((value) => resolve(value));
    });

    expect(metadata.name).toBe("test-service-service");
  });

  it("creates service with environment variables", async () => {
    const serviceArgs = {
      image: { repository: "nginx", tag: "latest" },
      replicas: 1,
      env: { NODE_ENV: "production", PORT: "3000" },
      httpPort: 3000,
      ports: [],
      hostVolumes: [],
      persistence: [],
    };

    const service = createService(mockProvider, "test-app", serviceArgs);

    expect(service).toBeDefined();
  });

  it("creates service with persistence volumes", async () => {
    const serviceArgs = {
      image: { repository: "postgres", tag: "14" },
      replicas: 1,
      env: {},
      httpPort: 5432,
      ports: [],
      hostVolumes: [],
      persistence: [
        {
          name: "data",
          storage: "10Gi",
          storageClassName: "hostpath",
          mountPath: "/var/lib/postgresql/data",
          readOnly: false,
          nodeAffinityHostname: "test-node",
          hostPath: "/data/postgres",
        },
      ],
    };

    const service = createService(mockProvider, "postgres", serviceArgs);

    expect(service).toBeDefined();
  });

  it("creates service with health checks", async () => {
    const serviceArgs = {
      image: { repository: "nginx", tag: "latest" },
      replicas: 1,
      env: {},
      httpPort: 80,
      ports: [],
      hostVolumes: [],
      persistence: [],
      healthCheck: {
        path: "/health",
        port: 80,
        enableLiveness: true,
        enableReadiness: true,
        enableStartup: false,
        initialDelaySeconds: 30,
        periodSeconds: 10,
        timeoutSeconds: 5,
        failureThreshold: 3,
        successThreshold: 1,
        expectedStatus: "UP" as const,
        followRedirects: false,
        httpHeaders: [],
      },
    };

    const service = createService(mockProvider, "web-app", serviceArgs);

    expect(service).toBeDefined();
  });

  it("creates service with resource limits", async () => {
    const serviceArgs = {
      image: { repository: "nginx", tag: "latest" },
      replicas: 2,
      env: {},
      httpPort: 80,
      ports: [],
      hostVolumes: [],
      persistence: [],
      limits: {
        cpu: "500m",
        memory: "512Mi",
      },
    };

    const service = createService(mockProvider, "limited-app", serviceArgs);

    expect(service).toBeDefined();
  });
});
