import { ImageSchema, LimitsSchema } from "@jaritanet/k8s";
import * as z from "zod";

/**
 * The login and consent provider.
 *
 * No `github` block: which OAuth app vouches for people is a fact about who
 * runs this, not about the component, so the stack extends this schema with it
 * the same way it does for the MCP gateway.
 *
 * An empty `hostname` means the service is not deployed — the same signal every
 * other publishable component here uses, and what keeps the real address out of
 * a public repository.
 */
export const AuthConfSchema = z.strictObject({
  hostname: z.string().default(""),
  image: ImageSchema,
  /**
   * Stateless apart from Redis, so this is only about surviving a node losing
   * a pod: every service's login goes through it, and one replica means a
   * rescheduled pod is a window where nobody can sign in to anything.
   */
  replicas: z.number().default(2),
  limits: LimitsSchema.default({ cpu: "100m", memory: "64Mi" }),
  /**
   * Holds one nonce per login in flight, for ten minutes. Pinned like anything
   * else, and deliberately not persisted — see the deployment.
   */
  redisImage: z.string().default("redis:8-alpine"),
});
