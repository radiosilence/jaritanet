terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

resource "cloudflare_record" "record" {
  name    = "_atproto"
  ttl     = 1
  type    = "TXT"
  content = "\"did=${var.bsky_did}\""
  zone_id = var.zone.id
}

