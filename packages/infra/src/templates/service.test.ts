import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";
import { ServiceArgsSchema } from "./service.schemas.ts";

describe("service template", () => {
  let mockProvider: k8s.Provider;
  const created: pulumi.runtime.MockResourceArgs[] = [];

  beforeAll(() => {
    // Set up mocks first
    pulumi.runtime.setMocks({
      call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
      newResource: (
        args: pulumi.runtime.MockResourceArgs,
      ): {
        id: string;
        state: any;
      } => {
        // Recorded so tests can assert on resources the template creates but
        // does not return — the NetworkPolicy and the Deployment.
        created.push(args);
        return {
          id: `${args.inputs.name || args.name || "test"}_id`,
          state: {
            ...args.inputs,
            id: `${args.inputs.name || args.name || "test"}_id`,
            metadata: {
              name: args.inputs.name || args.name || "test",
              ...args.inputs.metadata,
            },
          },
        };
      },
    });

    mockProvider = new k8s.Provider("test-provider", {
      kubeconfig: "fake-config",
    });
  });

  it("creates service with basic configuration", async () => {
    const { createService } = await import("./service.ts");
    const serviceArgs = ServiceArgsSchema.parse({
      env: {},
      hostVolumes: [],
      httpPort: 80,
      image: { repository: "nginx", tag: "latest" },
      persistence: [],
      ports: [],
      replicas: 1,
    });

    const service = createService(mockProvider, "test-service", serviceArgs);

    const metadata = await new Promise<any>((resolve) => {
      service.metadata.apply((value) => resolve(value));
    });

    expect(metadata.name).toBe("test-service-service");
  });

  it("creates service with environment variables", async () => {
    const { createService } = await import("./service.ts");
    const serviceArgs = ServiceArgsSchema.parse({
      env: { NODE_ENV: "production", PORT: "3000" },
      hostVolumes: [],
      httpPort: 3000,
      image: { repository: "nginx", tag: "latest" },
      persistence: [],
      ports: [],
      replicas: 1,
    });

    const service = createService(mockProvider, "test-app", serviceArgs);

    expect(service).toBeDefined();
  });

  it("creates service with persistence volumes", async () => {
    const { createService } = await import("./service.ts");
    const serviceArgs = ServiceArgsSchema.parse({
      env: {},
      hostVolumes: [],
      httpPort: 5432,
      image: { repository: "postgres", tag: "14" },
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
      ports: [],
      replicas: 1,
    });

    const service = createService(mockProvider, "postgres", serviceArgs);

    expect(service).toBeDefined();
  });

  it("creates service with health checks", async () => {
    const { createService } = await import("./service.ts");
    const serviceArgs = ServiceArgsSchema.parse({
      env: {},
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
        httpHeaders: [],
      },
      hostVolumes: [],
      httpPort: 80,
      image: { repository: "nginx", tag: "latest" },
      persistence: [],
      ports: [],
      replicas: 1,
    });

    const service = createService(mockProvider, "web-app", serviceArgs);

    expect(service).toBeDefined();
  });

  it("creates service with resource limits", async () => {
    const { createService } = await import("./service.ts");
    const serviceArgs = ServiceArgsSchema.parse({
      env: {},
      hostVolumes: [],
      httpPort: 80,
      image: { repository: "nginx", tag: "latest" },
      limits: {
        cpu: "500m",
        memory: "512Mi",
      },
      persistence: [],
      ports: [],
      replicas: 2,
    });

    const service = createService(mockProvider, "limited-app", serviceArgs);

    expect(service).toBeDefined();
  });

  describe("hardening", () => {
    const args = (over: Record<string, unknown> = {}) =>
      ServiceArgsSchema.parse({
        image: { repository: "nginx", tag: "latest" },
        httpPort: 4533,
        ...over,
      });
    const find = (type: string, name: string) =>
      created.find((r) => r.type.endsWith(type) && r.name === name);
    // Registration is async even under mocks, and resolving the returned
    // Service's urn is not enough — the Deployment and NetworkPolicy register
    // after it. So wait for the resource under test to actually appear.
    const waitFor = async (type: string, name: string) => {
      for (let i = 0; i < 100; i++) {
        const found = find(type, name);
        if (found) return found;
        // Sequential is the point — polling for something to appear.
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`${name} was never registered`);
    };

    it("never mounts a service account token", async () => {
      const { createService } = await import("./service.ts");
      createService(mockProvider, "plain", args());

      const deployment = await waitFor("Deployment", "plain-deployment");
      expect(
        deployment.inputs.spec.template.spec.automountServiceAccountToken,
      ).toBe(false);
    });

    it("confines egress only where asked, and never to private space", async () => {
      const { createService } = await import("./service.ts");
      createService(mockProvider, "open", args());
      createService(mockProvider, "confined", args({ networkPolicy: true }));

      const { inputs } = await waitFor("NetworkPolicy", "confined-netpol");
      await waitFor("Deployment", "open-deployment");
      // Opt-in: the unconfined service gets no policy at all, rather than one
      // that happens to allow everything.
      expect(find("NetworkPolicy", "open-netpol")).toBeUndefined();

      const spec = inputs.spec;
      expect(spec.policyTypes).toEqual(["Egress"]);
      // The tailnet and the node's own LAN are the addresses that turn an RCE
      // into host access, so their absence here is the whole point.
      expect(spec.egress[1].to[0].ipBlock.except).toEqual(
        expect.arrayContaining([
          "10.0.0.0/8",
          "192.168.0.0/16",
          "100.64.0.0/10",
        ]),
      );
      // DNS has to survive the deny above, or the pod resolves nothing.
      expect(spec.egress[0].ports).toEqual([
        { protocol: "UDP", port: 53 },
        { protocol: "TCP", port: 53 },
      ]);
    });

    it("keeps the kubelet reachable when ingress is restricted", async () => {
      const { createService } = await import("./service.ts");
      createService(
        mockProvider,
        "fenced",
        args({ networkPolicy: true, restrictIngress: true }),
      );

      const { spec } = (await waitFor("NetworkPolicy", "fenced-netpol")).inputs;
      expect(spec.policyTypes).toEqual(["Ingress", "Egress"]);

      const from = spec.ingress[0].from;
      expect(from[0].podSelector.matchLabels).toEqual({
        "app.kubernetes.io/name": "traefik",
      });
      // Probes originate from the node. Without this the pod fails readiness
      // and gets killed — the exact failure this option is gated behind.
      expect(from[1].ipBlock.cidr).toBe("192.168.0.0/16");
    });

    it("leaves ingress alone unless asked", async () => {
      const { createService } = await import("./service.ts");
      createService(mockProvider, "egressonly", args({ networkPolicy: true }));

      const { spec } = (await waitFor("NetworkPolicy", "egressonly-netpol"))
        .inputs;
      expect(spec.policyTypes).toEqual(["Egress"]);
      expect(spec.ingress).toBeUndefined();
    });

    it("fixes ownership of writable mounts, never read-only ones", async () => {
      const { createService } = await import("./service.ts");
      const withVolumes = (over: Record<string, unknown> = {}) =>
        ServiceArgsSchema.parse({
          image: { repository: "navidrome", tag: "1" },
          httpPort: 4533,
          persistence: [
            {
              name: "music",
              storage: "2Ti",
              hostPath: "/mnt/music",
              mountPath: "/music",
              readOnly: true,
              nodeAffinityHostname: "oldboy",
            },
            {
              name: "data",
              storage: "20Gi",
              hostPath: "/home/nd/data",
              mountPath: "/data",
              readOnly: false,
              nodeAffinityHostname: "oldboy",
            },
          ],
          ...over,
        });

      createService(mockProvider, "asroot", withVolumes());
      createService(
        mockProvider,
        "asuser",
        withVolumes({ securityContext: { runAsUser: 1001, runAsGroup: 1002 } }),
      );

      const spec = async (name: string) =>
        (await waitFor("Deployment", `${name}-deployment`)).inputs.spec.template
          .spec;

      // Nothing to fix when the pod runs as whatever the image says.
      expect((await spec("asroot")).initContainers).toBeUndefined();

      const init = (await spec("asuser")).initContainers[0];
      const cmd = init.command[2];
      expect(cmd).toContain("/data");
      // A recursive chown across a 2Ti library on every start would be a
      // catastrophe, and the mount would reject the write anyway.
      expect(cmd).not.toContain("/music");
      expect(cmd).toContain("1001:1002");
      // Must stay root: it is the thing granting the app its ownership.
      expect(init.securityContext.runAsUser).toBe(0);
    });

    it("drops capabilities only where asked", async () => {
      const { createService } = await import("./service.ts");
      createService(mockProvider, "caps", args());
      createService(mockProvider, "nocaps", args({ dropCapabilities: true }));

      const sc = async (name: string) =>
        (await waitFor("Deployment", `${name}-deployment`)).inputs.spec.template
          .spec.containers[0].securityContext;

      expect((await sc("caps")).capabilities).toBeUndefined();
      expect((await sc("nocaps")).capabilities).toEqual({ drop: ["ALL"] });
      // Applied regardless — it costs nothing and breaks nothing.
      expect((await sc("caps")).seccompProfile).toEqual({
        type: "RuntimeDefault",
      });
    });
  });
});
