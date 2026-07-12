import * as z from "zod";

export const EnvSchema = z.object({
  CLOUDFLARE_API_TOKEN: z.string().min(1, "CLOUDFLARE_API_TOKEN is required"),
  DEPLOY_TOKEN: z.string().optional(),
  GITHUB_REPOSITORY: z.string().default("radiosilence/jaritanet"),
  HCLOUD_TOKEN: z.string().optional(),
  KUBE_API_PORT: z.string().min(1, "KUBE_API_PORT is required"),
  KUBE_HOST: z.string().min(1, "KUBE_HOST is required"),
  KUBE_TOKEN: z.string().min(1, "KUBE_TOKEN is required"),
  TS_AUTHKEY: z.string().optional(),

  // sing-box profile delivery (Pulumi generates + ships the profile). All
  // optional — absent any of them, delivery is skipped. Telegram is optional
  // on top (notify only). Generic inputs get generic names; only the profile
  // slug is sing-box-specific.
  FILES_HOSTNAME: z.string().optional(),
  OLDBOY_HOST: z.string().optional(),
  OLDBOY_USER: z.string().default("jc"),
  SSH_PRIVATE_KEY: z.string().optional(),
  SINGBOX_SLUG: z.string().optional(),
  TAILNET_MAGICDNS_SUFFIX: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
});
