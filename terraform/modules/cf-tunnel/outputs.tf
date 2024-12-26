
output "token" {
  value       = cloudflare_zero_trust_tunnel_cloudflared.auto_tunnel.tunnel_token
  description = "The token to use for the tunnel."
}

output "cname" {
  value       = cloudflare_zero_trust_tunnel_cloudflared.auto_tunnel.cname
  description = "The CNAME record that routes to the tunnel."
}
