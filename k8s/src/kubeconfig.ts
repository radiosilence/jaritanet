interface KubeConfigArgs {
  host: string;
  apiPort: string;
  token: string;
}

export const kubeconfig = ({ host, apiPort, token }: KubeConfigArgs) =>
  JSON.stringify({
    apiVersion: "v1",
    kind: "Config",
    clusters: [
      {
        cluster: {
          server: `https://${host}:${apiPort}`,
          "insecure-skip-tls-verify": true,
        },
        name: "microk8s-cluster",
      },
    ],
    contexts: [
      {
        context: {
          cluster: "microk8s-cluster",
          user: "admin",
        },
        name: "microk8s",
      },
    ],
    "current-context": "microk8s",
    users: [
      {
        name: "admin",
        user: { token },
      },
    ],
  });
