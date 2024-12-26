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
