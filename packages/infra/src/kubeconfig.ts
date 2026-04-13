interface KubeConfigArgs {
  host: string;
  port?: string | number;
  token: string;
  caCert?: string;
}

export const getKubeconfig = ({
  host,
  port = 16_443,
  token,
}: KubeConfigArgs) => ({
  apiVersion: "v1",
  clusters: [
    {
      cluster: {
        server: `https://${host}:${port}`,
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
  kind: "Config",
  users: [
    {
      name: "admin",
      user: { token },
    },
  ],
});
