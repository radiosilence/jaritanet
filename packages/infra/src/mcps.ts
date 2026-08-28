import type { McpSchema } from "@radiosilence/mcp-gateway-pulumi";
import type * as z from "zod";

/**
 * The MCP servers this gateway fronts.
 *
 * Each entry is both a backend pod and its row in the registry the gateway
 * boots from (`MCP_REGISTRY`) — declared once, since a registry naming a pod
 * that does not exist is just a 502. The in-cluster URL joining the two is
 * derived, so nothing here says where an MCP lives.
 *
 * Images are pinned to release tags, not `:main`. A floating tag with the
 * default pull policy leaves a running pod on whatever it first pulled, so the
 * backends would silently drift from the gateway they serve.
 */
/**
 * The backends' images.
 *
 * Apart from the registry below so each is a single tracked line: the updater
 * matches a key in an exported `VERSIONS`, and four entries all called `image`
 * inside a list are not addressable that way.
 *
 * Rewritten in place by the version updater; see `.github/tracked-versions.yml`.
 */
export const VERSIONS = {
  caldav: "ghcr.io/radiosilence/caldav-cli:v0.6.3",
  fastmail: "ghcr.io/radiosilence/fastmail-cli:v3.5.0",
  folk: "ghcr.io/radiosilence/mainlynorfolk-mcp:v1.1.3",
  tfl: "ghcr.io/radiosilence/tfl-mcp:v1.3.4",
} as const;

export const MCPS: z.input<typeof McpSchema>[] = [
  {
    id: "fastmail",
    name: "Fastmail",
    image: VERSIONS.fastmail,
    args: ["mcp", "--http", "0.0.0.0:8080", "--graphql"],
    port: 8080,
    path: "/mcp",
    graphqlPath: "/graphql",
    keyHelpUrl: "https://app.fastmail.com/settings/security/tokens",
    // Mail runs on the API token; contacts go over CardDAV, which is a separate
    // protocol that rejects API tokens — hence three values rather than one.
    // The CardDAV pair is optional: without it mail works and contact search
    // does not, which the backend reports up front as
    // `session { carddavConfigured }` rather than failing a query halfway
    // through one. `token` keeps the id the credentialHeader shorthand
    // normalised to, so stored credentials survive the change.
    fields: [
      {
        id: "token",
        label: "API token",
        header: "X-Fastmail-Token",
        hint: "fmu1-…",
      },
      {
        id: "username",
        label: "Username (contacts only)",
        header: "X-Fastmail-Username",
        secret: false,
        required: false,
        hint: "you@fastmail.com",
      },
      // An app password, not the API token above: CardDAV won't take one.
      {
        id: "app_password",
        label: "App password (contacts only)",
        header: "X-Fastmail-App-Password",
        required: false,
        hint: "Blank = mail works, contact search doesn't",
      },
    ],
    // Re-runs the handshake rather than reading a cached client, so a revoked
    // token is caught rather than reported as fine. Only a 401 is a verdict on
    // the credential; rate limits and outages are UNREACHABLE.
    verify: {
      query: "{ session { status } }",
      path: "session.status",
      ok: "CONNECTED",
      rejected: "INVALID_CREDENTIALS",
    },
  },
  // CalDAV needs three values rather than one token, and serves plain GraphQL
  // beside /mcp so the dashboard can list an account's calendars in one request
  // instead of an MCP session handshake.
  {
    id: "caldav",
    name: "Calendar (CalDAV)",
    image: VERSIONS.caldav,
    args: ["mcp", "--http", "0.0.0.0:8080", "--graphql"],
    port: 8080,
    path: "/mcp",
    graphqlPath: "/graphql",
    keyHelpUrl: "https://appleid.apple.com",
    // A cheap PROPFIND for the principal — never touches the calendar list.
    verify: {
      query: "{ viewer { status } }",
      path: "viewer.status",
      ok: "CONNECTED",
      rejected: "INVALID_CREDENTIALS",
    },
    fields: [
      {
        id: "username",
        label: "Apple ID / username",
        header: "X-CalDAV-Username",
        secret: false,
        hint: "you@icloud.com",
      },
      {
        id: "password",
        label: "App-specific password",
        header: "X-CalDAV-Password",
        secret: true,
        hint: "abcd-efgh-ijkl-mnop",
      },
      {
        id: "url",
        label: "CalDAV server",
        header: "X-CalDAV-Url",
        secret: false,
        default: "https://caldav.icloud.com",
        required: false,
      },
      {
        id: "calendar",
        label: "Default calendar for new events",
        header: "X-CalDAV-Calendar",
        secret: false,
        required: false,
        hint: "Blank = whichever calendar your calendar app uses",
        // Keyed by id, not display name: two calendars can share a name (this
        // account has two "Family"), so a name is ambiguous — and the value is
        // what rides X-CalDAV-Calendar into every write. supportsEvents marks
        // the task-only collections nothing can land in.
        optionsQuery:
          "{ options: calendars(first: 100) { nodes { value: id label: name disabled: readOnly isDefault supportsEvents } } }",
        syncMutation:
          "mutation($value: String!) { setDefaultCalendar(id: $value) { success error } }",
      },
    ],
  },
  // The English folk archive. The first backend needing no credentials at all:
  // mainlynorfolk.info is a public website, so there is nothing to authenticate
  // to and nothing to store. `public: true` says so explicitly — an omitted
  // credential block is a schema error, not a licence to front an MCP
  // unauthenticated.
  {
    id: "folk",
    name: "Folk (Mainly Norfolk)",
    image: VERSIONS.folk,
    args: ["--http", "0.0.0.0:8080", "--graphql"],
    port: 8080,
    path: "/mcp",
    graphqlPath: "/graphql",
    public: true,
  },
  // TfL needs no key at all — anonymous callers get 50 requests/minute, which
  // is the same data, not a degraded tier. A key raises that to 500, so the
  // field is offered and optional: the proxy treats a missing credential as
  // fine and the backend simply runs anonymously, which means this works the
  // moment someone logs in.
  {
    id: "tfl",
    name: "TfL (London transport)",
    image: VERSIONS.tfl,
    args: ["--http", "0.0.0.0:8080", "--graphql"],
    port: 8080,
    path: "/mcp",
    graphqlPath: "/graphql",
    keyHelpUrl: "https://api-portal.tfl.gov.uk/profile",
    fields: [
      {
        id: "app_key",
        label: "TfL app key (optional — raises the rate limit)",
        header: "X-Tfl-App-Key",
        secret: true,
        required: false,
        hint: "32 hex characters",
      },
    ],
  },
];
