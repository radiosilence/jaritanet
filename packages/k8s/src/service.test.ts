import { setTimeout as sleep } from "node:timers/promises";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";
import { ServiceArgsSchema } from "./service.schemas.ts";

const nginxArgs = (over: Record<string, unknown> = {}) =>
  ServiceArgsSchema.parse({
    image: { repository: "nginx", tag: "latest" },
    httpPort: 4533,
    ...over,
  });

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
      httpPort: 80,
      image: { repository: "nginx", tag: "latest" },
      persistence: [],
      replicas: 1,
    });

    const service = createService(mockProvider, "test-service", serviceArgs);

    const metadata = await new Promise<any>((resolve) => {
      service.metadata.apply((value) => resolve(value));
    });

    expect(metadata.name).toBe("test-service-service");
  });

  it("creates service with persistence volumes", async () => {
    const { createService } = await import("./service.ts");
    const serviceArgs = ServiceArgsSchema.parse({
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
      replicas: 1,
    });

    const service = createService(mockProvider, "postgres", serviceArgs);

    expect(service).toBeDefined();
  });

  it("creates service with health checks", async () => {
    const { createService } = await import("./service.ts");
    const serviceArgs = ServiceArgsSchema.parse({
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
      httpPort: 80,
      image: { repository: "nginx", tag: "latest" },
      persistence: [],
      replicas: 1,
    });

    const service = createService(mockProvider, "web-app", serviceArgs);

    expect(service).toBeDefined();
  });

  it("creates service with resources", async () => {
    const { createService } = await import("./service.ts");
    const serviceArgs = ServiceArgsSchema.parse({
      httpPort: 80,
      image: { repository: "nginx", tag: "latest" },
      resources: {
        requests: { cpu: "10m", memory: "32Mi" },
        limits: { memory: "1Gi" },
      },
      persistence: [],
      replicas: 2,
    });

    const service = createService(mockProvider, "limited-app", serviceArgs);

    expect(service).toBeDefined();
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
      await sleep(5);
    }
    throw new Error(`${name} was never registered`);
  };
  const podSpec = async (name: string) =>
    (await waitFor("Deployment", `${name}-deployment`)).inputs.spec.template
      .spec;

  const securityContext = async (name: string) =>
    (await podSpec(name)).containers[0].securityContext;

  describe("hardening", () => {
    it("never mounts a service account token", async () => {
      const { createService } = await import("./service.ts");
      createService(mockProvider, "plain", nginxArgs());

      const deployment = await waitFor("Deployment", "plain-deployment");
      expect(
        deployment.inputs.spec.template.spec.automountServiceAccountToken,
      ).toBe(false);
    });

    it("confines egress only where asked, and never to private space", async () => {
      const { createService } = await import("./service.ts");
      createService(mockProvider, "open", nginxArgs());
      createService(
        mockProvider,
        "confined",
        nginxArgs({ networkPolicy: true }),
      );

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

    it("admits only Traefik when ingress is restricted", async () => {
      const { createService } = await import("./service.ts");
      createService(
        mockProvider,
        "fenced",
        nginxArgs({ networkPolicy: true, restrictIngress: true }),
      );

      const { spec } = (await waitFor("NetworkPolicy", "fenced-netpol")).inputs;
      expect(spec.policyTypes).toEqual(["Ingress", "Egress"]);

      // Kubelet probes need no rule: Cilium admits the local host to its own
      // endpoints, and an ipBlock would never have matched the node anyway.
      expect(spec.ingress[0].from).toEqual([
        {
          podSelector: { matchLabels: { "app.kubernetes.io/name": "traefik" } },
        },
      ]);
    });

    it("leaves ingress alone unless asked", async () => {
      const { createService } = await import("./service.ts");
      createService(
        mockProvider,
        "egressonly",
        nginxArgs({ networkPolicy: true }),
      );

      const { spec } = (await waitFor("NetworkPolicy", "egressonly-netpol"))
        .inputs;
      expect(spec.policyTypes).toEqual(["Egress"]);
      expect(spec.ingress).toBeUndefined();
    });

    it("confines every container to the runtime's default seccomp profile", async () => {
      const { createService } = await import("./service.ts");
      createService(mockProvider, "seccomp", nginxArgs());

      expect((await securityContext("seccomp")).seccompProfile).toEqual({
        type: "RuntimeDefault",
      });
    });
  });
});
