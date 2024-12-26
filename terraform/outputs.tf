output "jaritanet_tunnel_cname" {
  value       = jaritanet_tunnel.cname
  description = "The CNAME record that routes to the JARITANET tunnel."
}

output "jaritanet_tunnel_token" {
  value       = jaritanet_tunnel.token
  description = "The token to use for the JARITANET tunnel."
}
