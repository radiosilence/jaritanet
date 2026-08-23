import { sha256hex } from "@jaritanet/k8s";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { VERSIONS } from "./versions.ts";

/**
 * Serves a table of path → body out of a Secret, and nothing else.
 *
 * The routing table *is* the content, which is the whole point of the binary:
 * a path that leaves the table stops existing rather than lingering as a file
 * someone has to remember to delete, and rotation is a Secret update.
 *
 * A Secret rather than a ConfigMap because a caller with a table worth hiding
 * has nowhere else to put it — the sing-box profiles this was built for carry
 * every credential a device needs.
 *
 * Two properties come from the container and are load-bearing wherever the
 * paths are secret: it never logs the requested path, and it refuses to start
 * on a malformed table rather than answering 404 to everyone, which would look
 * like every client being broken at once.
 *
 * What the caller keeps is what the table *means* — how the paths are derived
 * and what the bodies say. This knows only that it is JSON.
 */
export function createServeFromEnv(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  name: string,
  /** A JSON object of path → body. */
  routes: pulumi.Input<string>,
) {
  // Hashed through `pulumi.secret` so the annotation carries the same
  // secretness the table does: a caller whose paths are the credential should
  // not have a value derived from them sitting in plain state.
  const routesHash = sha256hex(pulumi.secret(routes)).apply((h) =>
    h.slice(0, 16),
  );

  const secret = new k8s.core.v1.Secret(
    name,
    { metadata: { name, namespace }, stringData: { ROUTES: routes } },
    { provider },
  );

  new k8s.apps.v1.Deployment(
    name,
    {
      metadata: { name, namespace },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: {
            labels: { app: name },
            // ROUTES arrives as an environment variable, which is read once at
            // exec. Without this the pod would keep serving the table it
            // started with after a rotation, silently.
            annotations: { "jaritanet/routes": routesHash },
          },
          spec: {
            automountServiceAccountToken: false,
            containers: [
              {
                name,
                image: VERSIONS.serveFromEnv,
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

  const service = new k8s.core.v1.Service(
    `${name}-service`,
    {
      metadata: { name: `${name}-service`, namespace },
      spec: {
        ports: [{ port: 80, protocol: "TCP", targetPort: 8080 }],
        selector: { app: name },
      },
    },
    { provider },
  );

  /** `secret` so a caller can order work after the table exists; `routesHash`
   *  so it can key its own notifications on the table having changed. */
  return { secret, service, routesHash };
}
