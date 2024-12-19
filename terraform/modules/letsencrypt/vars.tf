variable "zone" {
  description = "The Cloudflare zone to use"
  type = object({
    name = string
    id   = string
  })
}
