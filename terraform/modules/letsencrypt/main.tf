terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

resource "cloudflare_record" "record" {
  name    = var.zone.name
  proxied = false
  ttl     = 1
  type    = "CAA"
  zone_id = var.zone.id
  data {
    flags = 0
    tag   = "issue"
    value = "letsencrypt.org"
  }
}

