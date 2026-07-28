import * as z from "zod";

/**
 * The entry node's caching resolver. Only the image is configurable —
 * everything else about it is determined by the role (loopback only, DoT
 * upstream), and a knob for it would be a way to get it wrong.
 */
export const UnboundConfSchema = z.object({
  image: z.string().default("docker.io/klutchell/unbound:v1.24.0"),
});
