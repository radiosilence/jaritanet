/**
 * Everything left in `Pulumi.main.yaml`, and everything that has to be.
 *
 * Stack config used to describe the whole deployment; it now holds only what
 * cannot be committed in the clear. Everything else moved to `stack.ts`, where
 * the compiler checks it, the editor completes it, and a value used twice is
 * one binding rather than two entries that can disagree.
 *
 * `getObject` returns plaintext. The `secure:` wrapper exists in the stack file,
 * and the `[secret]` in a deploy's output is the engine redacting its own
 * stdout, so one Zod parse still validates the whole block.
 */
import * as pulumi from "@pulumi/pulumi";
import * as z from "zod";

const SecretsSchema = z.strictObject({
  /** Handed to Traefik for the DNS-01 challenge. The `cloudflare:apiToken`
   *  provider key holds the same value; nothing can read that one back. */
  cloudflareApiToken: z.string().min(1),
  /** The OAuth app the identity provider authenticates people against. */
  githubClientSecret: z.string().min(1),
  hcloudToken: z.string().min(1),
  /** Joins the gateway, every edge, and the in-cluster relay. */
  tailnetAuthKey: z.string().optional(),
  /** Policy-as-code. Absent → the policy stays hand-managed in the console. */
  tailnetOauthClientSecret: z.string().optional(),
  telegramBotToken: z.string().optional(),
  telegramChatId: z
    .string()
    .regex(/^-?\d+$/, "must be a Telegram chat id (an integer)")
    .optional(),
  /** Ubuntu Pro, for livepatch. Absent → patches still land on reboot. */
  ubuntuProToken: z.string().optional(),
  /** Comma-separated; a trailing `+` marks an admin. See `parseVpnUsers`. */
  vpnUsers: z.string().optional(),
});

const config = new pulumi.Config();

export const secrets = SecretsSchema.parse(config.requireObject("secrets"));
