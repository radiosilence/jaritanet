terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
  required_version = ">= 1.8.2"
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# blit.cc
module "blit" {
  source = "./modules/zone"
  zone   = var.blit_zone
  modules = [
    "letsencrypt",
    "fastmail",
    "github",
    "bluesky",
  ]
  subdomains = {
    "music" = {
      type    = "CNAME"
      content = var.jaritanet_cname
      proxied = true
    }
  }
}

# buttholes.live
module "buttholes" {
  source = "./modules/zone"
  zone   = var.buttholes_zone
  modules = [
    "fastmail",
    "bluesky",
  ]
}

# radiosilence.dev
module "radiosilence" {
  source = "./modules/zone"
  zone   = var.radiosilence_zone
  modules = [
    "bluesky",
    "fastmail",
  ]
  subdomains = {
    "bambi" = {
      type    = "CNAME"
      content = var.jaritanet_cname
      proxied = true
    }
    "files" = {
      type    = "CNAME"
      content = var.jaritanet_cname
      proxied = true
    }
  }
}
