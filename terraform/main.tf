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
  name   = "jaritanet"
  zones = {
    music = {
      name    = "music.${var.blit_zone.name}"
      id      = var.blit_zone.id
      service = "http://navidrome-service.navidrome.svc.cluster.local"
    }
    files = {
      name    = "files.${var.radiosilence_zone.name}"
      id      = var.radiosilence_zone.id
      service = "http://files-service.files.svc.cluster.local"
    }
    bambi = {
      name    = "bambi.${var.radiosilence_zone.name}"
      id      = var.radiosilence_zone.id
      service = "http://bambi-art-service.bambi-art.svc.cluster.local"
    }
    blit_test = {
      name    = "blit.${var.radiosilence_zone.name}"
      id      = var.blit_zone.id
      service = "http://blit-service.blit.svc.cluster.local"
    }
  }
  cloudflare_account_id = var.cloudflare_account_id
  cloudflare_api_token  = var.cloudflare_api_token
  cloudflare_email      = var.cloudflare_email
  cloudflare_team_name  = var.cloudflare_team_name
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
      content = module.jaritanet_tunnel.cname
      proxied = true
    }
    "test" = {
      type    = "CNAME"
      content = module.jaritanet_tunnel.cname
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
      content = module.jaritanet_tunnel.cname
      proxied = true
    }
    "files" = {
      type    = "CNAME"
      content = module.jaritanet_tunnel.cname
      proxied = true
    }
  }
}
