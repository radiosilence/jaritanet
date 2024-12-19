variable "zone" {
  description = "The Cloudflare zone to use"
  type = object({
    name = string
    id   = string
  })
}

variable "github_a_records" {
  description = "A set of GitHub Pages A records to create"
  type        = set(string)
  default     = ["185.199.108.153", "185.199.109.153", "185.199.110.153", "185.199.111.153"]
}

variable "github_verify" {
  description = "The GitHub Pages verification string to use"
  type = object({
    name  = string
    value = string
  })
  default = {
    name  = "_github-pages-challenge-radiosilence"
    value = "963852554fb760462512037c38879e"
  }
}
