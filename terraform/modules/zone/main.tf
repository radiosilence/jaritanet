terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

module "letsencrypt" {
  source = "../letsencrypt"
  zone   = var.zone
  count  = contains(var.modules, "letsencrypt") ? 1 : 0
}

module "fastmail" {
  source = "../fastmail"
  zone   = var.zone
  count  = contains(var.modules, "fastmail") ? 1 : 0
}

module "github" {
  source = "../github"
  zone   = var.zone
  count  = contains(var.modules, "github") ? 1 : 0
}

module "bluesky" {
  source = "../bluesky"
  zone   = var.zone
  count  = contains(var.modules, "bluesky") ? 1 : 0
}

resource "cloudflare_record" "cnames" {
  for_each = var.subdomains
  name     = each.key
  ttl      = 1
  type     = each.value.type
  content  = each.value.content
  proxied  = each.value.proxied
  zone_id  = var.zone.id
}
