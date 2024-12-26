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

  cloud {
    organization = "radiosilence"

    workspaces {
      name = "blit-cloudflare"
    }
  }

}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# jaritanet tunnel
module "jaritanet_tunnel" {
  source = "./modules/cf-tunnel"
  zones = {
    music = {
      name = "musi-tun.${var.blit_zone.name}"
      id   = var.blit_zone.id
    }
  }
  cloudflare_account_id = var.cloudflare_account_id
  cloudflare_api_token  = var.cloudflare_api_token
  cloudflare_email      = var.cloudflare_email
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
      type    = "A"
      content = var.jaritanet_ip
      proxied = true
    }
    "musi-tun" = {
      type    = "A"
      content = jaritanet_tunnel.cname
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
      type    = "A"
      content = var.jaritanet_ip
      proxied = true
    }
    "files" = {
      type    = "A"
      content = var.jaritanet_ip
      proxied = true
    }
  }
}
