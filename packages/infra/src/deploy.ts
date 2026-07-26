#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * Drives the stack from CI, for both `preview` and `up`.
 *
 * A preview is only worth reading if it was produced the same way as the deploy
 * it predicts. Assembling the configuration separately in each workflow meant
 * nothing enforced that, and the two had already drifted apart.
 *
 * Configuration is written to the checked-out Pulumi.main.yaml rather than to
 * the shared stack, so hostnames injected for one PR's preview never reach
 * another's.
 */
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
// Explicit file, and a namespace import: the automation API is CommonJS with
// no exports map, so neither a bare subpath nor a named import resolves.
import * as automation from "@pulumi/pulumi/automation/index.js";

const STACK = "radiosilence/jaritanet/main";
const WORK_DIR = join(import.meta.dirname, "..");

/** GitHub refuses a comment body beyond 65536 characters. */
const COMMENT_LIMIT = 60_000;

/**
 * Injected from CI secrets, so this public repo carries no hostnames. Set
 * unconditionally: the checked-in values are empty strings, and writing one
 * back is what an absent secret should mean.
 */
const CONFIG_FROM_ENV = {
  "jaritanet:cloudflare.accountId": "CLOUDFLARE_ACCOUNT_ID",
  "jaritanet:traefik.acmeEmail": "ACME_EMAIL",
  "jaritanet:services.navidrome.hostname": "NAVIDROME_HOSTNAME",
  "jaritanet:services.files.hostname": "FILES_HOSTNAME",
  "jaritanet:services.blit.hostname": "BLIT_HOSTNAME",
  "jaritanet:gateway.xray.serverName": "BLIT_HOSTNAME",
  "jaritanet:mcpGateway.hostname": "MCP_HOSTNAME",
  "jaritanet:mcpGateway.authHostname": "MCP_AUTH_HOSTNAME",
} as const;

const env = (name: string) => process.env[name] ?? "";

/**
 * Where the home server currently answers from. Only meaningful in direct mode:
 * the cluster sits behind a residential connection whose address moves, and
 * only something running inside the cluster can see what it has become.
 */
async function detectExternalIp() {
  const token = Buffer.from(env("KUBE_TOKEN"), "base64").toString("utf8");
  const { stdout } = await promisify(execFile)("kubectl", [
    `--server=https://${env("KUBE_HOST")}:${env("KUBE_API_PORT")}`,
    `--token=${token}`,
    "--insecure-skip-tls-verify",
    "run",
    "detect-ip",
    "--rm",
    "-i",
    "--restart=Never",
    "--quiet",
    "--image=curlimages/curl",
    "--",
    "-4",
    "-s",
    "https://1.1.1.1/cdn-cgi/trace",
  ]);
  return stdout
    .split("\n")
    .find((line) => line.startsWith("ip="))
    ?.slice(3)
    .trim();
}

/**
 * Truncated from the top, because the resource summary a preview is read for
 * sits at the end of the output.
 */
function previewComment(output: string) {
  const overflowed = output.length > COMMENT_LIMIT;
  const body = overflowed ? output.slice(-COMMENT_LIMIT) : output;
  const note = overflowed
    ? `\n> Truncated to the last ${COMMENT_LIMIT} characters — see the run for the whole preview.\n`
    : "";
  return `#### Pulumi preview — \`${STACK}\`\n${note}\n\`\`\`\n${body}\n\`\`\`\n`;
}

const mode = process.argv[2];
if (mode !== "preview" && mode !== "up") {
  throw new Error(`expected "preview" or "up", got "${mode ?? ""}"`);
}

const stack = await automation.LocalWorkspace.createOrSelectStack({
  stackName: STACK,
  workDir: WORK_DIR,
});

await stack.setAllConfig(
  Object.fromEntries(
    Object.entries(CONFIG_FROM_ENV).map(([key, source]) => [
      key,
      { value: env(source) },
    ]),
  ),
  true,
);

if (!env("HCLOUD_TOKEN")) {
  const externalIp = await detectExternalIp();
  process.stdout.write(
    `detected server external IP: ${externalIp ?? "none"}\n`,
  );
  if (externalIp) {
    await stack.setConfig("jaritanet:externalIp", { value: externalIp });
  }
}

const onOutput = (out: string) => process.stdout.write(out);

if (mode === "up") {
  await stack.up({ refresh: true, onOutput });
} else {
  const { stdout } = await stack.preview({
    refresh: true,
    color: "never",
    onOutput,
  });
  const commentPath = process.env.PREVIEW_COMMENT_PATH;
  if (commentPath) {
    await writeFile(commentPath, previewComment(stdout));
  }
}
