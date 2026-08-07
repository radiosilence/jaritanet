import { describe, expect, it } from "vitest";
import { renderKubeconfig } from "./k3s.ts";

// Shape and ordering as k3s writes it, with the base64 truncated. The `default`
// on the `client-certificate-data` line is the accident the anchors exist for.
const RAW = `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: LS0tCmRlZmF1bHQK
    server: https://127.0.0.1:6443
  name: default
contexts:
- context:
    cluster: default
    user: default
  name: default
current-context: default
kind: Config
preferences: {}
users:
- name: default
  user:
    client-certificate-data: ZGVmYXVsdAo=default
    client-key-data: a2V5Cg==
`;

describe("renderKubeconfig", () => {
  const rendered = renderKubeconfig(RAW, "gateway.example.ts.net", "jaritanet");

  it("points the server at the name the certificate covers", () => {
    expect(rendered).toContain("server: https://gateway.example.ts.net:6443");
    expect(rendered).not.toContain("127.0.0.1");
  });

  it("renames all six of cluster, context and user", () => {
    expect(rendered.match(/jaritanet$/gm)).toHaveLength(6);
    expect(rendered).not.toMatch(/^\s*-?\s*(name|cluster|user):\s*default$/m);
    expect(rendered).toContain("current-context: jaritanet");
  });

  it("leaves certificate data alone", () => {
    expect(rendered).toContain("certificate-authority-data: LS0tCmRlZmF1bHQK");
    expect(rendered).toContain("client-certificate-data: ZGVmYXVsdAo=default");
  });
});
