import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it } from "vitest";

describe("service routing utilities", () => {
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
        },
      }),
      call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
    });
  });

  describe("getRecord", () => {
    it("extracts zone and record from full hostname", async () => {
      const { getRecord } = await import("./service.ts");
      const result = getRecord("api.example.com");
      expect(result.zoneName).toBe("example.com");
      expect(result.recordName).toBe("api");
    });

    it("handles apex domain", async () => {
      const { getRecord } = await import("./service.ts");
      const result = getRecord("example.com");
      expect(result.zoneName).toBe("example.com");
      expect(result.recordName).toBe("@");
    });

    it("handles multi-level subdomains", async () => {
      const { getRecord } = await import("./service.ts");
      const result = getRecord("deep.nested.example.com");
      expect(result.zoneName).toBe("example.com");
      expect(result.recordName).toBe("deep.nested");
    });
  });

  describe("getServiceIngress", () => {
    it("creates ingress config with hostname and service", async () => {
      const { getServiceIngress } = await import("./service.ts");
      const ingress = getServiceIngress(
        "api.example.com",
        "http://api-service:80",
      );

      expect(ingress.hostname).toBe("api.example.com");
      expect(ingress.service).toBe("http://api-service:80");
      expect((ingress.originRequest as any)?.connectTimeout).toBe(120);
    });

    it("creates ingress config for internal k8s service", async () => {
      const { getServiceIngress } = await import("./service.ts");
      const ingress = getServiceIngress(
        "files.example.com",
        "http://files-service.jaritanet.svc.cluster.local",
      );

      expect(ingress.hostname).toBe("files.example.com");
      expect(ingress.service).toBe(
        "http://files-service.jaritanet.svc.cluster.local",
      );
    });
  });

  describe("createZone", () => {
    it("creates DNS record with correct configuration", async () => {
      const { createZone } = await import("./service.ts");
      const zoneConf = {
        zoneId: "test-zone-id",
        name: "example.com",
        modules: [] as ("bluesky" | "fastmail")[],
      };
      const serviceConf = {
        service: "http://api-service:80",
        hostname: "api.example.com",
        proxied: true,
      };

      const record = createZone("tunnel.example.com", zoneConf, serviceConf);

      const name = await new Promise<string>((resolve) => {
        record.name.apply((value) => resolve(value));
      });

      const type = await new Promise<string>((resolve) => {
        record.type.apply((value) => resolve(value));
      });

      const content = await new Promise<string>((resolve) => {
        record.content.apply((value) => resolve(value));
      });

      expect(name).toBe("api");
      expect(type).toBe("CNAME");
      expect(content).toBe("tunnel.example.com");
    });

    it("creates apex domain record", async () => {
      const { createZone } = await import("./service.ts");
      const zoneConf = {
        zoneId: "test-zone-id",
        name: "example.com",
        modules: [] as ("bluesky" | "fastmail")[],
      };
      const serviceConf = {
        service: "http://example-service:80",
        hostname: "example.com",
        proxied: false,
      };

      const record = createZone("tunnel.example.com", zoneConf, serviceConf);

      const name = await new Promise<string>((resolve) => {
        record.name.apply((value) => resolve(value));
      });

      const proxied = await new Promise<boolean>((resolve) => {
        record.proxied.apply((value) => resolve(value));
      });

      expect(name).toBe("@");
      expect(proxied).toBe(false);
    });
  });
});
