variable "zone" {
  description = "The Cloudflare zone to use"
  type = object({
    name = string
    id   = string
  })
}

variable "bsky_did" {
  description = "The DID of the Bluesky agent to use"
  type        = string
  default     = "did:plc:d32vuqlfqjttwbckkxgxgbgl"
}
