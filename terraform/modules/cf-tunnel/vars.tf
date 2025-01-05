variable "cloudflare_account_id" {
  description = "The account ID of the Cloudflare account to use"
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
