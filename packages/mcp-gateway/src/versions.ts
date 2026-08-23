/**
 * Pinned images for the gateway and the authorization server beside it.
 *
 * Rewritten in place by the version updater; see `.github/tracked-versions.yml`.
 */
export const VERSIONS = {
  mcpGateway: "ghcr.io/radiosilence/mcp-gateway:v0.7.1",
} as const;

/**
 * Pins the updater deliberately does not watch, and why. Separate from
 * `VERSIONS` because the test that every pin is tracked has to tell a decision
 * from an oversight — ss-rust sat invisible in a schema default for a year.
 */
export const UNTRACKED = {
  /**
   * Postgres publishes patches into the major tag, which is the whole of what
   * is wanted from it. There is no release here to follow.
   */
  postgres: "postgres:16",
  /**
   * Moved by hand, with the release notes open. Hydra owns the database holding
   * every registered client and a major bump needs `hydra migrate sql` run
   * against it — and Ory's unified versioning puts "latest" more than twenty
   * majors ahead of the schema this database was created by, so an unattended
   * bump is every service unable to log anybody in at once.
   */
  hydra: "oryd/hydra:v2.2.0",
} as const;
