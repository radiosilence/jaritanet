/* eslint-disable no-console -- a CLI script: console is its output channel */
// Gives a freshly registered node the tailnet name its configured hostname
// asks for, removing the registrations of the machines it replaced. Run by the
// tailscale-name local command; see createTailscaleSystemd for why. Piped to
// node over stdin, so it must stay self-contained.

const API = "https://api.tailscale.com/api/v2";

export type Device = {
  nodeId: string;
  /** The hostname the node registered with, which `--hostname` sets. */
  hostname: string;
  /** The MagicDNS name, `<label>.<tailnet suffix>`. */
  name: string;
  tags?: string[];
};

/**
 * Works out which devices to delete and whether the node needs renaming.
 *
 * A device is a predecessor when it registered with the same hostname under the
 * same tag: the tag means this stack's key registered it, so a person's laptop
 * that happens to share the name is never touched. The node itself is excluded
 * by its own id, read from the box, which is what makes this safe to run
 * against a node that is already correctly named: there is nothing to delete
 * and nothing to rename.
 */
export function planClaim(
  devices: Device[],
  { self, hostname, tag }: { self: string; hostname: string; tag: string },
) {
  const node = devices.find((d) => d.nodeId === self);
  if (!node) {
    throw new Error(`node ${self} is not in the tailnet's device list`);
  }
  return {
    remove: devices
      .filter(
        (d) =>
          d.nodeId !== self &&
          d.hostname === hostname &&
          (d.tags ?? []).includes(tag),
      )
      .map((d) => d.nodeId),
    rename: node.name.split(".")[0] !== hostname,
  };
}

async function call(
  token: string,
  method: string,
  path: string,
  body?: object,
) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body && { "content-type": "application/json" }),
    },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) {
    const hint =
      res.status === 403
        ? " (the OAuth client needs the devices:core scope with write access)"
        : "";
    throw new Error(
      `${method} ${path}: ${res.status} ${await res.text()}${hint}`,
    );
  }
  return res;
}

function env(key: string) {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is not set`);
  return value;
}

if (import.meta.main) {
  const hostname = env("TAILNET_HOSTNAME");

  const auth = await fetch(`${API}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      client_id: env("TAILNET_OAUTH_CLIENT_ID"),
      client_secret: env("TAILNET_OAUTH_CLIENT_SECRET"),
    }),
  });
  if (!auth.ok) {
    throw new Error(`oauth token: ${auth.status} ${await auth.text()}`);
  }
  const { access_token: token } = (await auth.json()) as {
    access_token: string;
  };

  const { devices } = (await (
    await call(token, "GET", "/tailnet/-/devices")
  ).json()) as { devices: Device[] };
  const self = env("TAILNET_SELF");
  const { remove, rename } = planClaim(devices, {
    self,
    hostname,
    tag: env("TAILNET_TAG"),
  });

  for (const id of remove) {
    // oxlint-disable-next-line no-await-in-loop -- one line of output per deletion, in order
    await call(token, "DELETE", `/device/${id}`);
    console.log(`deleted stale device ${id}`);
  }
  if (rename) {
    await call(token, "POST", `/device/${self}/name`, { name: hostname });
    console.log(`renamed ${self} to ${hostname}`);
  }
  if (!remove.length && !rename) {
    console.log(`${self} already holds ${hostname}`);
  }
}
