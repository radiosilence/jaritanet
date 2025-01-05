variable "cloudflare_api_token" {
  description = "The API token to use for the Cloudflare provider"
  type        = string
  sensitive   = true
}

variable "cloudflare_team_name" {
  description = "The name of the Cloudflare team to use"
  type        = string
}

variable "name" {
  description = "The name of the tunnel"
  type        = string
}

variable "zones" {
  description = "The zones to use"
  type = map(object({
    name    = string
    id      = string
    service = string
  }))
}
