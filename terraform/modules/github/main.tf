terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

resource "cloudflare_record" "verify" {
  type    = "TXT"
  name    = var.github_verify.name
  content = "\"${var.github_verify.value}\""
  zone_id = var.zone.id
}

resource "cloudflare_record" "a" {
  name     = "@"
  proxied  = false
  ttl      = 1
  type     = "A"
  content  = each.key
  for_each = var.github_a_records
  zone_id  = var.zone.id
}

resource "cloudflare_record" "a_www" {
  name    = "www"
  proxied = false
  ttl     = 1
  type    = "CNAME"
  content = var.zone.name
  zone_id = var.zone.id
}
