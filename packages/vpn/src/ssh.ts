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
 *
 * `replaceWith` is the machine itself. `dependsOn` only orders: a command keeps
 * its recorded success when the box under it is rebuilt, so the new box comes
 * up without the transport while the stack reports no drift. Every command
 * here is replaced along with these resources, which re-runs it on the new box.
 * A resource option rather than the server id in `triggers`, because a new
 * trigger re-runs the command on the next deploy and this does not.
 * `serverTriggers` in `@jaritanet/hetzner` is the trigger form, kept for the
 * commands that already used it.
 */
export type SystemdOpts = {
  name?: string;
  dependsOn?: pulumi.Resource[];
  replaceWith?: pulumi.Resource[];
};
