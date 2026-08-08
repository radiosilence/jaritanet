import { describe, expect, it } from "vitest";
import * as yaml from "yaml";
import { NAMESPACE, NODE_IP, NODE_NAME, scrapeConfig } from "./scrape.ts";

/**
 * What this file is guarding is not the YAML — it is the one property the whole
 * collection design rests on: an agent scrapes its own node and nothing else. A
 * config that quietly reached across to the other node would double every
 * series, and the duplicate is indistinguishable from a busy machine.
 */
describe("scrapeConfig", () => {
  const config = yaml.parse(scrapeConfig("30s"));
  const jobs: Record<string, Record<string, unknown>> = Object.fromEntries(
    config.scrape_configs.map((j: { job_name: string }) => [j.job_name, j]),
  );

  it("targets this pod's own node, never a name", () => {
    for (const [name, job] of Object.entries(jobs)) {
      for (const s of (job.static_configs ?? []) as { targets: string[] }[]) {
        for (const target of s.targets) {
          expect(target, name).toContain(NODE_IP);
        }
      }
    }
  });

  /**
   * Both agents run the same config, so without this every pod in the namespace
   * is scraped once per node.
   */
  it("keeps only pods scheduled on this node", () => {
    const relabels = jobs.pods?.relabel_configs as {
      source_labels?: string[];
      regex?: string;
      action?: string;
    }[];
    expect(relabels).toContainEqual({
      source_labels: ["__meta_kubernetes_pod_node_name"],
      regex: NODE_NAME,
      action: "keep",
    });
  });

  /** Discovery across every namespace would pull in the cluster's own pods. */
  it("discovers pods in its own namespace only", () => {
    expect(jobs.pods?.kubernetes_sd_configs).toEqual([
      { role: "pod", namespaces: { names: [NAMESPACE] } },
    ]);
  });

  /**
   * The agent's own metrics port is not among these: Cilium and Hubble are two
   * servers on one pod, so an annotation can only ever advertise one of them.
   */
  it("scrapes the agent and Hubble as separate targets", () => {
    expect(jobs["cilium-agent"]?.static_configs).toEqual([
      { targets: [`${NODE_IP}:9962`] },
    ]);
    expect(jobs.hubble?.static_configs).toEqual([
      { targets: [`${NODE_IP}:9965`] },
    ]);
  });

  /** Both kubelet endpoints authenticate by token; neither can verify the cert. */
  it("authenticates to the kubelet with the ServiceAccount token", () => {
    for (const name of ["kubelet", "cadvisor"]) {
      expect(jobs[name]?.bearer_token_file, name).toBe(
        "/var/run/secrets/kubernetes.io/serviceaccount/token",
      );
      expect(jobs[name]?.scheme, name).toBe("https");
    }
    expect(jobs.cadvisor?.metrics_path).toBe("/metrics/cadvisor");
  });

  it("labels every sample with the machine it came from", () => {
    expect(config.global.external_labels).toEqual({ node: NODE_NAME });
    expect(config.global.scrape_interval).toBe("30s");
  });
});
