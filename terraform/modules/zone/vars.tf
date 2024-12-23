variable "zone" {
  description = "The Cloudflare zone to use"
  type = object({
    name = string
    id   = string
  })
}

variable "modules" {
  description = "The modules to use"
  type        = list(string)
}

variable "subdomains" {
  description = "Additional subdomains"
  type = map(object({
    type    = string,
    content = string,
    proxied = bool
  }))
  default = {}
}

variable "cloudflare_api_token" {
  description = "The API token to use for the Cloudflare provider"
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_account_id" {
  description = "The account ID of the Cloudflare account to use"
  type        = string
  default     = ""
}
variable "cloudflare_email" {
  description = "The email address of the Cloudflare account to use"
  type        = string
  default     = ""
}
