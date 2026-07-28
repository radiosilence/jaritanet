import { describe, expect, it } from "vitest";
import * as yaml from "yaml";
import { McpSchema } from "./mcp-gateway.schemas.ts";
import { mcpRegistry } from "./mcp-gateway.ts";

/**
 * The registry is the contract with the gateway: it is parsed at boot, and a
 * key spelled our way rather than its way is a crash loop, not a warning. So
 * these assert the wire format, not our config's.
 */
const svcDns = (name: string) => `${name}.ns.svc.cluster.local`;

describe("mcpRegistry", () => {
  const parse = (mcps: unknown[]) =>
    yaml.parse(
      mcpRegistry(
        mcps.map((m) => McpSchema.parse(m)),
        svcDns,
      ),
    );

  it("derives backend URLs from the Services declared alongside", () => {
    const [entry] = parse([
      {
        id: "caldav",
        name: "Calendar",
        image: "x",
        graphqlPath: "/graphql",
        credentialHeader: "X-Token",
      },
    ]);
    expect(entry.backend).toBe(
      "http://mcp-gateway-mcp-caldav.ns.svc.cluster.local:8080/mcp",
    );
    expect(entry.graphql).toBe(
      "http://mcp-gateway-mcp-caldav.ns.svc.cluster.local:8080/graphql",
    );
  });

  it("renames camelCase config onto the gateway's snake_case keys", () => {
    const [entry] = parse([
      {
        id: "caldav",
        name: "Calendar",
        image: "x",
        keyHelpUrl: "https://example.test",
        fields: [
          {
            id: "calendar",
            label: "Calendar",
            header: "X-CalDAV-Calendar",
            required: false,
            optionsQuery: "{ options { value label } }",
            syncMutation: "mutation($value: String!) { set(id: $value) }",
          },
        ],
      },
    ]);
    expect(entry.key_help_url).toBe("https://example.test");
    expect(entry.fields[0]).toMatchObject({
      options_query: "{ options { value label } }",
      sync_mutation: "mutation($value: String!) { set(id: $value) }",
      required: false,
    });
  });

  it("omits what was not configured rather than emitting empty keys", () => {
    const [entry] = parse([
      { id: "folk", name: "Folk", image: "x", public: true },
    ]);
    expect(entry).toEqual({
      id: "folk",
      name: "Folk",
      backend: "http://mcp-gateway-mcp-folk.ns.svc.cluster.local:8080/mcp",
      public: true,
    });
  });
});
