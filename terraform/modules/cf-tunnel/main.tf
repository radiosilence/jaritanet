terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 4.49.1"
    }
    random = {
      source = "hashicorp/random"
    }
  }
  required_version = ">= 1.8.2"
}

# Generates a 64-character secret for the tunnel.
# Using `random_password` means the result is treated as sensitive and, thus,
# not displayed in console output. Refer to: https://registry.terraform.io/providers/hashicorp/random/latest/docs/resources/password
resource "random_password" "tunnel_secret" {
  length = 64
}

# Creates a new locally-managed tunnel for the k8s.
resource "cloudflare_zero_trust_tunnel_cloudflared" "auto_tunnel" {
  account_id = var.cloudflare_account_id
  name       = var.name
  secret     = base64sha256(random_password.tunnel_secret.result)
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "auto_tunnel" {
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.auto_tunnel.id
  account_id = var.cloudflare_account_id
  config {
    dynamic "ingress_rule" {
      for_each = var.zones
      content {
        hostname = ingress_rule.value["name"]
        service  = ingress_rule.value["service"]
        origin_request {
          connect_timeout = "2m0s"
        }
      }
    }
    ingress_rule {
      service = "http_status:404"
    }
  }
}
