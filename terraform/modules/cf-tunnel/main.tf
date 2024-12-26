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
  name       = "Terraform tunnel"
  secret     = base64sha256(random_password.tunnel_secret.result)
}

# Creates the CNAME record that routes http_app.${var.cloudflare_zone} to the tunnel.
resource "cloudflare_record" "http_app" {
  zone_id = var.zone.id
  name    = var.zone.name
  content = cloudflare_zero_trust_tunnel_cloudflared.auto_tunnel.cname
  type    = "CNAME"
  proxied = true
}


# # TODO Creates the configuration for the tunnel.
# resource "cloudflare_zero_trust_tunnel_cloudflared_config" "auto_tunnel" {
#   tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.auto_tunnel.id
#   account_id = var.cloudflare_account_id
#   config {
#     ingress_rule {
#       hostname = cloudflare_record.http_app.hostname
#       service  = "http://oldboy:80" # TODO Replace with your service.
#       origin_request {
#         connect_timeout = "2m0s"
#         access {
#           required  = true
#           team_name = "myteam" # TODO Replace with your team name.
#           aud_tag   = [cloudflare_zero_trust_access_application.http_app.aud]
#         }
#       }
#     }
#     ingress_rule {
#       service = "http_status:404"
#     }
#   }
# }

# # TODO Creates an Access application to control who can connect.
# resource "cloudflare_zero_trust_access_application" "http_app" {
#   zone_id          = var.zone.id
#   name             = "Access application for ${var.zone.name}"
#   domain           = var.zone.name
#   session_duration = "1h"
# }

# # TODO Creates an Access policy for the application.
# resource "cloudflare_zero_trust_access_policy" "http_policy" {
#   application_id = cloudflare_zero_trust_access_application.http_app.id
#   zone_id        = var.zone.id
#   name           = "Allow policy for ${var.zone.name}"
#   precedence     = "1"
#   decision       = "allow"
#   include {
#     email = [var.cloudflare_email]
#   }
# }
