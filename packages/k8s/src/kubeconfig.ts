interface KubeConfigArgs {
  host: string;
  port?: string | number;
  token: string;
  caCert?: string;
}

export const getKubeconfig = ({
  host,
  port = 16443,
  token,
}: KubeConfigArgs) => ({
  apiVersion: "v1",
  kind: "Config",
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
  users: [
    {
      name: "admin",
      user: { token },
    },
  ],
});
