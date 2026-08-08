import * as crypto from "node:crypto";
import { sha256hex } from "@jaritanet/k8s";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { VpnUser } from "./users.ts";
import {
  buildProfile,
  type Exit,
  notifyProfileUrls,
  type ResolvedExit,
  type ResolvedNode,
  type SingboxNode,
} from "./singbox.ts";

/**
 * Serves each user's sing-box profile, from a Secret, in the cluster.
 *
 * The old delivery wrote the same JSON over SSH onto a file server and let
 * nginx read it off disk. Pulumi already holds every profile as a string, so
 * the disk was a round trip that bought nothing and cost three things: an SSH
 * write to a specific machine, a sweep to stop rotated slugs continuing to
 * serve revoked credentials, and a hostname that had to exist on the box being
 * migrated — which is precisely the thing you cannot rely on while migrating.
 *
 * Here the routing table *is* the content. `serve-from-env` takes a JSON object
 * of path → body and serves exactly those paths, 404 for everything else. So a
 * rotated URL stops existing rather than lingering as a file someone has to
 * remember to delete, and rotation is a Secret update.
 *
 * A Secret rather than a ConfigMap: these carry every credential a device needs
 * — REALITY UUIDs, hysteria passwords, the exit PSK for admins.
 *
 * Two properties inherited from the container, both load-bearing here: it never
 * logs the requested path (an access log would be a list of live subscription
 * URLs), and it refuses to start on a malformed table rather than answering 404
 * to everyone, which would look like every client being broken at once.
 */
export function createProfileServer(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  users: VpnUser[],
  nodes: SingboxNode[],
  opts: {
    slug: pulumi.Input<string>;
    magicdnsSuffix: string;
    image: string;
    exits?: Exit[];
    hostname: string;
    telegram?: { botToken: pulumi.Output<string>; chatId: string };
  },
) {
  // Unguessable path per user, derived from the secret base slug — stable
  // across deploys so a subscription keeps working, unguessable without the
  // base. Same scheme the file server used, so existing URLs keep their shape.
  const pathFor = (slug: string, name: string) =>
    `/${crypto
      .createHash("sha256")
      .update(`${slug}:${name}`)
      .digest("hex")
      .slice(0, 32)}.json`;

  const routes = pulumi
    .all([
      pulumi.output(nodes),
      pulumi.output(opts.exits ?? []),
      pulumi.output(opts.slug),
    ])
    .apply(([resolved, resolvedExits, slug]) =>
      JSON.stringify(
        Object.fromEntries(
          users.map((user) => [
            pathFor(slug, user.name),
            JSON.stringify(
              buildProfile(
                user,
                resolved as ResolvedNode[],
                opts.magicdnsSuffix,
                resolvedExits as ResolvedExit[],
              ),
              null,
              2,
            ),
          ]),
        ),
      ),
    );

  const routesHash = sha256hex(pulumi.secret(routes)).apply((h) =>
    h.slice(0, 16),
  );

  const secret = new k8s.core.v1.Secret(
    "singbox-profiles",
    {
      metadata: { name: "singbox-profiles", namespace },
      stringData: { ROUTES: routes },
    },
    { provider },
  );

  const app = "singbox-profiles";
  new k8s.apps.v1.Deployment(
    "singbox-profiles",
    {
      metadata: { name: app, namespace },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app } },
        template: {
          metadata: {
            labels: { app },
            // ROUTES arrives as an environment variable, which is read once at
            // exec. Without this the pod would keep serving the profiles it
            // started with after a rotation, silently.
            annotations: { "jaritanet/routes": routesHash },
          },
          spec: {
            automountServiceAccountToken: false,
            containers: [
              {
                name: app,
                image: opts.image,
                ports: [{ name: "http", containerPort: 8080 }],
                envFrom: [{ secretRef: { name: secret.metadata.name } }],
                resources: { limits: { cpu: "100m", memory: "64Mi" } },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  seccompProfile: { type: "RuntimeDefault" },
                  // Listens on 8080, owns no files, shells out to nothing.
                  capabilities: { drop: ["ALL"] },
                  readOnlyRootFilesystem: true,
                  runAsNonRoot: true,
                },
              },
            ],
          },
        },
      },
    },
    { provider },
  );

  if (opts.telegram) {
    notifyProfileUrls(
      users.map((user) => ({
        name: user.name,
        role: user.role,
        url: pulumi
          .output(opts.slug)
          .apply(
            (slug) => `https://${opts.hostname}${pathFor(slug, user.name)}`,
          ),
      })),
      opts.telegram,
      routesHash,
      [secret],
    );
  }

  return new k8s.core.v1.Service(
    "singbox-profiles-service",
    {
      metadata: { name: `${app}-service`, namespace },
      spec: {
        ports: [{ port: 80, protocol: "TCP", targetPort: 8080 }],
        selector: { app },
      },
    },
    { provider },
  );
}
