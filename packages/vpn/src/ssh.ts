import type * as pulumi from "@pulumi/pulumi";

/**
 * An SSH connection to a box the transports are installed on.
 *
 * Structurally identical to the one `@jaritanet/hetzner` exports, and
 * deliberately redeclared rather than imported: the systemd installers work on
 * anything reachable over SSH, and a dependency on a cloud provider's package
 * for the sake of a four-field type would be the only thing tying them to it.
 */
export type SshConnection = {
  host: pulumi.Output<string>;
  privateKey: pulumi.Output<string>;
  user: string;
};

/**
 * Resource-name prefix for a node. Empty name = the primary node, keeping its
 * original resource names so Pulumi doesn't replace live infrastructure;
 * additional nodes pass a name and get prefixed names.
 */
export const resourcePrefix = (name: string) => (name ? `${name}-` : "");

/**
 * Naming and ordering for a transport installed over SSH.
 *
 * `dependsOn` carries whatever has to exist before the box is reachable —
 * the server resource, in practice. Taking it as opaque resources rather than a
 * typed machine is what keeps these installers usable against any host with an
 * SSH port, cloud provider or not.
 */
export type SystemdOpts = {
  name?: string;
  dependsOn?: pulumi.Resource[];
};
