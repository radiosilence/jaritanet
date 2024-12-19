terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

resource "cloudflare_record" "record_fm_mx" {
  for_each = tomap({
    "in1" = 10,
    "in2" = 20,
  })
  name     = var.zone.name
  priority = each.value
  ttl      = 1
  type     = "MX"
  content  = "${each.key}-${var.mx_domain}"
  zone_id  = var.zone.id
}

resource "cloudflare_record" "record_fm_dkim" {
  for_each = toset(["fm1", "fm2", "fm3", "fm4"])
  name     = "${each.key}.${var.dkim_subdomain}"
  proxied  = false
  ttl      = 1
  type     = "CNAME"
  content  = "${each.key}.${var.zone.name}.${var.dkim_domain}"
  zone_id  = var.zone.id
}


resource "cloudflare_record" "record_fm_spf" {
  name    = var.zone.name
  ttl     = 1
  type    = "TXT"
  content = "\"v=spf1 include:${var.spf_domain} ?all\""
  zone_id = var.zone.id
}

resource "cloudflare_record" "record_fm_dmarc" {
  name    = var.dmarc_subdomain
  ttl     = 1
  type    = "TXT"
  content = "\"v=DMARC1; p=${var.dmarc_policy}; rua=mailto:${var.dmarc_agg_email}\""
  zone_id = var.zone.id
}

