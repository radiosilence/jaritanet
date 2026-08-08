import { AbsolutePath, ImageSchema, LimitsSchema } from "@jaritanet/k8s";
import * as z from "zod";

/**
 * A directory the service may write to, and one the picker browses.
 *
 * One declaration produces both the pod's mount and the option offered in the
 * interface, so the picker cannot offer somewhere the process cannot write.
 *
 * The host path is also the path inside the container. That is what lets a
 * directory travel from the browse endpoint to aria2's `dir` without either
 * side translating it — there is one name for a place rather than two that can
 * disagree about which one aria2 was told to use.
 */
export const MariastewRootSchema = z.strictObject({
  name: z.string().min(1),
  hostPath: AbsolutePath,
});

/**
 * aria2's runtime policy. Every field is a flag with a reason.
 *
 * `seedRatio` is the one worth reading twice. Seeding indefinitely is
 * `--seed-ratio=0.0`, where zero means no limit — not `--seed-time=0`, which
 * means do not seed at all, and not the default ratio of 1.0, which stops the
 * moment you have given back what you took.
 *
 * Bandwidth is deliberately unlimited in both directions. The media volume is a
 * mechanical disk in a USB enclosure and gets there well before a gigabit link
 * does, so throttling the network would be solving the wrong problem. The knob
 * that matters is `maxConcurrentDownloads`, and for disk reasons rather than
 * network ones: concurrent torrents are concurrent write streams landing in
 * different regions of one spindle, which is a seek storm rather than
 * throughput. Lower it first if downloads are slow while the network is idle —
 * that combination means seeks. It stops mattering once the media is on an SSD.
 */
export const Aria2ConfSchema = z.strictObject({
  btMaxPeers: z.number().int().nonnegative().default(0),
  maxConcurrentDownloads: z.number().int().positive().default(16),
  maxConnectionPerServer: z.number().int().positive().default(16),
  maxOverallDownloadLimit: z.string().default("0"),
  maxOverallUploadLimit: z.string().default("0"),
  seedRatio: z.string().default("0.0"),
});

/**
 * The torrent web UI, and the aria2 it fronts.
 *
 * `hostname` empty means built but not published, the same convention the other
 * services use. `oidc` absent — or carrying an empty issuer, which is how the
 * repository holds the value in the clear while the real one is set as a
 * secret — means the service is not deployed at all: it is a write endpoint
 * onto the media library, and one that cannot authenticate should not exist.
 * The caller enforces that, because skipping a service is a decision about this
 * deployment rather than about the component.
 */
export const MariastewConfSchema = z.object({
  // `prefault` rather than `default`: it substitutes before parsing, so the
  // field's own defaults fill an omitted block in. `default` takes the parsed
  // type, which would mean writing every flag out a second time here.
  aria2: Aria2ConfSchema.prefault({}),
  hostname: z.string().default(""),
  image: ImageSchema,
  limits: LimitsSchema.default({ cpu: "2000m", memory: "1Gi" }),
  /**
   * Where to send the browser, and under what name. That is the whole of what
   * a relying party knows about identity: the registration — the secret and
   * the redirect URI — belongs to the provider, which derives the URI from the
   * hostname below and generates the secret itself. A service that could type
   * its own redirect URI would be a service that could widen its own
   * permissions.
   */
  oidc: z
    .object({
      clientId: z.string().default("mariastew"),
      issuer: z.string(),
    })
    .optional(),
  roots: z.array(MariastewRootSchema).min(1),
});
