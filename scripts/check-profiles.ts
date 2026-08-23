#!/usr/bin/env -S node --experimental-strip-types
/**
 * Runs the real sing-box binary over every profile shape we deliver.
 *
 * `singbox.schema.test.ts` validates against the *published* schema, which is
 * always the latest release — so it cannot answer the question that actually
 * costs us: will the core our devices run accept this? July's outage was
 * `store_dns`, valid in current sing-box and rejected by the 1.13 cores every
 * device was on, and every device fetches the same file, so the whole fleet
 * went down at once.
 *
 * `check` is a stronger test than any schema: it runs the version's own parser
 * and initialises the outbounds, so it rejects a malformed REALITY key or an
 * unknown field alike. The cost is that fixtures must be plausible rather than
 * merely well-shaped.
 */
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildProfile } from "../packages/vpn/src/singbox.ts";

/**
 * The oldest core a delivered profile must work on. Raising it is a deliberate
 * act: every device has to be on the new version first, or the next profile
 * change is free to use a field that bricks the ones that aren't. Note that
 * SagerNet does not publish a container image for every release — pick one that
 * has one.
 */
const MIN_CORE = "v1.14.0-alpha.47";
const IMAGE = `ghcr.io/sagernet/sing-box:${MIN_CORE}`;

// Well-formed rather than real: `check` initialises outbounds, so a REALITY
// key has to be 32 bytes of base64url and a UUID has to parse.
const node = {
  name: "primary",
  server: "1.2.3.4",
  hysteria: {
    altPorts: [3478, 4500],
    obfsPassword: "obfs-password",
    passwords: { guest1: "guest-pw", jc: "admin-pw" },
    port: 443,
    sni: "www.bing.com",
  },
  reality: {
    publicKey: "VQw0Oi7DtJ4Ck_-cPdrjma1wlbCzpkQe_AE3UzjmY5Y",
    serverNames: ["www.google.co.uk", "www.bing.com", "www.apple.com"],
    shortId: "0123456789abcdef",
    uuids: {
      guest1: "22222222-2222-2222-2222-222222222222",
      jc: "11111111-1111-1111-1111-111111111111",
    },
  },
};
const edge = { ...node, name: "helsinki", server: "5.6.7.8" };
// `server` is the exit's tailnet address, and it was missing here — so every
// profile this validated carried an exit outbound with no server at all, which
// is not a shape any device is ever handed. Nothing caught it because scripts/
// was not typechecked.
const exits = [
  {
    name: "home",
    port: 9000,
    method: "aes-128-gcm",
    password: "ss-psk",
    server: "100.64.0.1",
  },
];

const profiles = [
  ["admin-single", { name: "jc", role: "admin" } as const, [node]],
  ["guest-single", { name: "guest1", role: "guest" } as const, [node]],
  ["admin-multi", { name: "jc", role: "admin" } as const, [node, edge]],
  ["guest-multi", { name: "guest1", role: "guest" } as const, [node, edge]],
] as const;

const run = promisify(execFile);

const hasDocker = async () => {
  try {
    await run("docker", ["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    return false;
  }
};

if (!(await hasDocker())) {
  // CI always has one; locally this is a convenience, not a gate.
  console.log("no docker daemon — skipping sing-box check");
  process.exit(0);
}

const dir = await mkdtemp(join(tmpdir(), "jaritanet-profiles-"));
let failed = 0;

for (const [label, user, nodes] of profiles) {
  const file = join(dir, `${label}.json`);
  await writeFile(
    file,
    JSON.stringify(buildProfile(user, [...nodes], "ts.net", exits), null, 2),
  );
  try {
    await run("docker", [
      "run",
      "--rm",
      "-v",
      `${file}:/config.json:ro`,
      "--entrypoint",
      "sing-box",
      IMAGE,
      "check",
      "-c",
      "/config.json",
    ]);
    console.log(`  ok    ${label}`);
  } catch (err) {
    failed++;
    const { stderr, stdout } = err as { stderr?: string; stdout?: string };
    console.error(`  FAIL  ${label}\n${(stderr || stdout || "").trim()}`);
  }
}

console.log(
  failed
    ? `\n${failed}/${profiles.length} profiles rejected by sing-box ${MIN_CORE}`
    : `\nall ${profiles.length} profiles accepted by sing-box ${MIN_CORE}`,
);
process.exit(failed ? 1 : 0);
