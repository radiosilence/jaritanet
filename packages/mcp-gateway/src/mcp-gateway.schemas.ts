import * as z from "zod";
import { ResourcesSchema } from "./contract.ts";

/** One value a backend MCP needs from the user, injected into its own header. */
export const McpCredentialFieldSchema = z.object({
  id: z.string(),
  label: z.string(),
  header: z.string(),
  secret: z.boolean().optional(),
  default: z.string().optional(),
  hint: z.string().optional(),
  required: z.boolean().optional(),
  /** Query whose results become this field's suggestions in the dashboard. */
  optionsQuery: z.string().optional(),
  /** Mutation run after a save, telling the backend what was picked. */
  syncMutation: z.string().optional(),
});

/**
 * An MCP the gateway fronts: one Deployment + Service, and one entry in the
 * registry handed to the gateway. Declared once because the two cannot
 * meaningfully disagree — a registry entry naming a pod that does not exist is
 * a 502 waiting to happen, and the in-cluster URL joining them is derived, not
 * written down.
 *
 * `credentialHeader` is the shorthand for the common one-token case;
 * `fields` covers backends wanting several values (CalDAV needs a username, an
 * app password, and a server URL); `public` covers a backend fronting something
 * public, which needs neither. Exactly one of the three, matching what the
 * gateway's registry accepts.
 *
 * `public` is opt-in rather than inferred from an absent credential block: a
 * backend declaring no credentials is far more often a typo than a decision,
 * and the deploy should fail rather than quietly front an unauthenticated MCP.
 */
export const McpSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    image: z.string(),
    args: z.array(z.string()).default([]),
    port: z.number().default(8080),
    path: z.string().default("/mcp"),
    credentialHeader: z.string().optional(),
    fields: z.array(McpCredentialFieldSchema).optional(),
    /** Takes no credentials at all — see the note above. */
    public: z.boolean().optional(),
    /**
     * Path to a plain GraphQL endpoint the backend serves beside its MCP one,
     * for the dashboard's own lookups. In-cluster only — never proxied.
     */
    graphqlPath: z.string().optional(),
    keyHelpUrl: z.string().optional(),
    keyHint: z.string().optional(),
    /**
     * How to ask this backend whether the stored credentials still work, so the
     * dashboard can distinguish one that is configured from one that is
     * working. Omit it and the gateway claims nothing, which is the honest
     * answer for a backend that authenticates nothing.
     *
     * `path`, `ok` and `rejected` are all optional because backends disagree
     * about how to report bad auth: one that raises needs only a query, one
     * that answers calmly with a status names the values. Nothing is ever
     * reported as rejected unless `rejected` says which value means it — an
     * unreachable server is not evidence about a password.
     */
    verify: z
      .object({
        query: z.string(),
        path: z.string().optional(),
        ok: z.string().optional(),
        rejected: z.string().optional(),
      })
      .optional(),
  })
  .refine(
    (b) =>
      [!!b.credentialHeader, !!b.fields?.length, !!b.public].filter(Boolean)
        .length === 1,
    { message: "set exactly one of credentialHeader, fields, or public" },
  );

/** The MCP Gateway stack (gateway + Hydra + Postgres + the MCPs it fronts). */
export const McpGatewayConfSchema = z.object({
  // Blank in the (public) repo; injected at CI time from secrets, so the source
  // reveals no hostnames. An empty hostname skips the stack (see infra main.ts).
  replicas: z.number().default(2),
  limits: ResourcesSchema.default({ cpu: "500m", memory: "256Mi" }),
  /**
   * Left to the deployer rather than derived from `limits`.
   *
   * How much of a ceiling to reserve is a scheduling policy — it depends on
   * what else shares the node and how bursty it is — so it belongs to whoever
   * runs the cluster, not to the chart. Absent means Kubernetes defaults the
   * request to the limit, which is the conservative reading.
   */
  requests: ResourcesSchema.optional(),
  // Postgres uses the cluster's default StorageClass unless set — a few tiny
  // tables, so (unlike the media services) we don't pin them to a disk path.
  postgresStorageClass: z.string().optional(),
  mcps: z.array(McpSchema).default([]),
});
