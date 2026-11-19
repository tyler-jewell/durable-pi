# Feed the host bootstrap (scripts/bootstrap-studio-ssh.sh). The tokens and keys are sensitive: read them with
# `terraform output -raw <name>`, never paste them into a log.

output "tunnel_id" {
  description = "ID of the studio tunnel (cloudflared runs with its token)"
  value       = cloudflare_tunnel.studio.id
}

output "tunnel_token" {
  description = "Token for cloudflared to run the studio tunnel (sensitive)"
  value       = cloudflare_tunnel.studio.tunnel_token
  sensitive   = true
}

output "service_token_client_id" {
  description = "Client ID of the agent service token, for the non-interactive SSH lane (sensitive)"
  value       = cloudflare_access_service_token.agent.client_id
  sensitive   = true
}

output "service_token_client_secret" {
  description = "Client secret of the agent service token (sensitive)"
  value       = cloudflare_access_service_token.agent.client_secret
  sensitive   = true
}

output "short_lived_cert_ca_public_key" {
  description = "Public key of the per-app short-lived SSH certificate CA (sensitive)"
  value       = cloudflare_zero_trust_access_short_lived_certificate.studio_ssh.public_key
  sensitive   = true
}
