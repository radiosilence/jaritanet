import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as tailscale from "@pulumi/tailscale";
import type * as pulumi from "@pulumi/pulumi";

/**
 * Manages the tailnet's policy file as code.
 *
 * The tailnet is the last line of defence for anything that reaches the
 * gateway: the gateway is a member so it can relay `100.x` over the tunnel, so
 * whatever it may reach, a bug at the Xray or Hysteria layer may also reach.
 * #162 was exactly that — guest routing rules that looked like they blocked the
 * tailnet but did not, because IP rules never matched domain destinations. A
 * grant limiting what the gateway can talk to would have contained it without
 * anyone noticing the bug.
 *
 * The policy is a file rather than a JS object because HuJSON keeps comments,
 * and a policy whose reasoning is stripped out is a policy nobody dares edit.
 *
 * `overwriteExistingContent` is deliberately left false. The provider then
 * refuses to touch a policy it has not imported, so merging this cannot clobber
 * a hand-maintained tailnet — the import is a conscious step, not a surprise.
 * See README for the sequence.
 */
export function createTailnetPolicy(
  clientId: pulumi.Input<string>,
  clientSecret: pulumi.Input<string>,
  tailnet: string,
) {
  const provider = new tailscale.Provider("tailscale", {
    oauthClientId: clientId,
    oauthClientSecret: clientSecret,
    tailnet,
  });

  return new tailscale.Acl(
    "tailnet-policy",
    {
      acl: readFileSync(
        join(import.meta.dirname, "../../tailnet-policy.hujson"),
        "utf8",
      ),
    },
    { provider },
  );
}
