import * as command from "@pulumi/command";
import * as oci from "@pulumi/oci";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as tls from "@pulumi/tls";

/**
 * Provisions an Oracle Cloud free-tier ARM instance running rathole.
 * Uses the Always Free VM.Standard.A1.Flex shape (1 OCPU, 6GB RAM)
 * which is absurd overkill for a TCP relay, but it's free forever.
 *
 * Credentials read from Pulumi config (oci:tenancyOcid, etc.) and
 * the private key from OCI_PRIVATE_KEY env var (PEM with newlines
 * is too painful to pass through pulumi config set).
 */
export function createOciGateway(ratholeVersion: string) {
  const ociConfig = new pulumi.Config("oci");
  const tenancyOcid = ociConfig.require("tenancyOcid");
  const userOcid = ociConfig.require("userOcid");
  const fingerprint = ociConfig.require("fingerprint");
  const region = ociConfig.require("region");
  const privateKey = process.env.OCI_PRIVATE_KEY;

  if (!privateKey) {
    throw new Error("OCI_PRIVATE_KEY env var is required for OCI gateway");
  }

  // Explicit provider so we can pass the private key from env
  const ociProvider = new oci.Provider("oci", {
    fingerprint,
    privateKey,
    region,
    tenancyOcid,
    userOcid,
  });

  const opts = { provider: ociProvider };

  const ratholeToken = new random.RandomPassword("rathole-token", {
    length: 64,
  });

  const sshKey = new tls.PrivateKey("gateway-ssh-key", {
    algorithm: "ED25519",
  });

  const ad = oci.identity
    .getAvailabilityDomainsOutput({ compartmentId: tenancyOcid }, opts)
    .apply((ads) => ads.availabilityDomains[0]!.name!);

  const ubuntuImage = oci.core
    .getImagesOutput(
      {
        compartmentId: tenancyOcid,
        operatingSystem: "Canonical Ubuntu",
        operatingSystemVersion: "24.04",
        shape: "VM.Standard.A1.Flex",
        sortBy: "TIMECREATED",
        sortOrder: "DESC",
      },
      opts,
    )
    .apply((images) => images.images[0]!.id!);

  const vcn = new oci.core.Vcn(
    "gateway-vcn",
    {
      compartmentId: tenancyOcid,
      cidrBlocks: ["10.0.0.0/16"],
      displayName: "jaritanet-gateway",
    },
    opts,
  );

  const internetGateway = new oci.core.InternetGateway(
    "gateway-igw",
    {
      compartmentId: tenancyOcid,
      displayName: "jaritanet-igw",
      vcnId: vcn.id,
    },
    opts,
  );

  const routeTable = new oci.core.RouteTable(
    "gateway-routes",
    {
      compartmentId: tenancyOcid,
      displayName: "jaritanet-routes",
      routeRules: [
        {
          destination: "0.0.0.0/0",
          destinationType: "CIDR_BLOCK",
          networkEntityId: internetGateway.id,
        },
      ],
      vcnId: vcn.id,
    },
    opts,
  );

  const securityList = new oci.core.SecurityList(
    "gateway-seclist",
    {
      compartmentId: tenancyOcid,
      displayName: "jaritanet-seclist",
      egressSecurityRules: [{ destination: "0.0.0.0/0", protocol: "all" }],
      ingressSecurityRules: [
        {
          description: "SSH",
          protocol: "6",
          source: "0.0.0.0/0",
          tcpOptions: { min: 22, max: 22 },
        },
        {
          description: "HTTP",
          protocol: "6",
          source: "0.0.0.0/0",
          tcpOptions: { min: 80, max: 80 },
        },
        {
          description: "HTTPS",
          protocol: "6",
          source: "0.0.0.0/0",
          tcpOptions: { min: 443, max: 443 },
        },
        {
          description: "Rathole control",
          protocol: "6",
          source: "0.0.0.0/0",
          tcpOptions: { min: 2333, max: 2333 },
        },
      ],
      vcnId: vcn.id,
    },
    opts,
  );

  const subnet = new oci.core.Subnet(
    "gateway-subnet",
    {
      cidrBlock: "10.0.1.0/24",
      compartmentId: tenancyOcid,
      displayName: "jaritanet-subnet",
      routeTableId: routeTable.id,
      securityListIds: [securityList.id],
      vcnId: vcn.id,
    },
    opts,
  );

  // ARM instance — rathole via Docker (no ARM binary published)
  const cloudInit = `#!/bin/bash
set -euo pipefail
apt-get update && apt-get install -y docker.io
systemctl enable docker && systemctl start docker
mkdir -p /etc/rathole

cat > /etc/systemd/system/rathole.service << 'UNIT'
[Unit]
Description=Rathole Server
After=docker.service
Requires=docker.service

[Service]
ExecStartPre=-/usr/bin/docker stop rathole
ExecStartPre=-/usr/bin/docker rm rathole
ExecStart=/usr/bin/docker run --name rathole --net=host -v /etc/rathole:/etc/rathole rapiz1/rathole:${ratholeVersion} --server /etc/rathole/server.toml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable rathole
`;

  const instance = new oci.core.Instance(
    "gateway",
    {
      availabilityDomain: ad,
      compartmentId: tenancyOcid,
      createVnicDetails: {
        assignPublicIp: "true",
        subnetId: subnet.id,
      },
      displayName: "jaritanet-gateway",
      metadata: {
        ssh_authorized_keys: sshKey.publicKeyOpenssh,
        user_data: Buffer.from(cloudInit).toString("base64"),
      },
      shape: "VM.Standard.A1.Flex",
      shapeConfig: {
        memoryInGbs: 6,
        ocpus: 1,
      },
      sourceDetails: {
        sourceId: ubuntuImage,
        sourceType: "image",
      },
    },
    opts,
  );

  const vpsIp = instance.publicIp;

  const connection = {
    host: vpsIp,
    privateKey: sshKey.privateKeyOpenssh,
    user: "ubuntu",
  };

  const ratholeConfig = pulumi.interpolate`[server]
bind_addr = "0.0.0.0:2333"
default_token = "${ratholeToken.result}"

[server.services.https]
type = "tcp"
bind_addr = "0.0.0.0:443"

[server.services.http]
type = "tcp"
bind_addr = "0.0.0.0:80"
`;

  const configUpload = new command.remote.Command(
    "rathole-config",
    {
      connection,
      create: pulumi.interpolate`cat > /etc/rathole/server.toml << 'RATHOLE_EOF'
${ratholeConfig}
RATHOLE_EOF`,
      triggers: [ratholeToken.result],
    },
    { dependsOn: [instance] },
  );

  new command.remote.Command(
    "rathole-restart",
    {
      connection,
      create: "systemctl restart rathole",
      triggers: [configUpload.id],
    },
    { dependsOn: [configUpload] },
  );

  return {
    ratholeToken,
    vpsIp,
  };
}
