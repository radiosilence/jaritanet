
output "tunnel_token" {
  value       = cloudflare_zero_trust_tunnel_cloudflared.auto_tunnel.tunnel_token
  description = "The token to use for the tunnel."
}
