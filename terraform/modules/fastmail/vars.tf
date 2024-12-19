variable "zone" {
  description = "The Cloudflare zone to use"
  type = object({
    name = string
    id   = string
  })
}

variable "mx_domain" {
  description = "The base domain to use for MX records"
  type        = string
  default     = "smtp.messagingengine.com"
}

variable "dkim_domain" {
  description = "The base domain to use for DKIM records"
  type        = string
  default     = "dkim.fmhosted.com"
}

variable "dkim_subdomain" {
  description = "The subdomain to use for DKIM records"
  type        = string
  default     = "_domainkey"
}

variable "dmarc_subdomain" {
  description = "The subdomain to use for DMARC records"
  type        = string
  default     = "_dmarc"
}

variable "dmarc_agg_email" {
  description = "The email address to use for DKIM aggregate reports"
  type        = string
  default     = "dmarc-agg@blit.cc"
}

variable "dmarc_policy" {
  description = "The DMARC policy to use"
  type        = string
  default     = "reject"
}

variable "spf_domain" {
  description = "The base domain to use for SPF records"
  type        = string
  default     = "spf.messagingengine.com"
}
