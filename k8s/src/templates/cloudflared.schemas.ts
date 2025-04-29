import { z } from "zod";

export const CloudflaredArgsSchema = z.interface({
  "replicas?": z.int().default(2),
});
