output "jaritanet_tunnel_cname" {
  value       = module.jaritanet_tunnel.cname
  description = "The CNAME record that routes to the JARITANET tunnel."
}

output "jaritanet_tunnel_token" {
  value       = module.jaritanet_tunnel.token
  description = "The token to use for the JARITANET tunnel."
  sensitive   = true
}
