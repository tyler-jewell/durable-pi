# Feed the host bootstrap (scripts/bootstrap-studio-ssh.sh). Tokens and keys are sensitive: read them with
# `terraform output -raw <name>`, never paste them into a log.

output "tunnel_id" {
  description = "ID of the studio tunnel"
  value       = cloudflare_zero_trust_tunnel_cloudflared.studio.id
}

output "tunnel_token" {
  description = "Token for cloudflared to run the studio tunnel (sensitive)"
  value       = data.cloudflare_zero_trust_tunnel_cloudflared_token.studio.token
  sensitive   = true
}

output "short_lived_cert_ca_public_key" {
  description = "Public key of the per-app short-lived SSH certificate CA (sensitive)"
  value       = cloudflare_zero_trust_access_short_lived_certificate.studio_ssh.public_key
  sensitive   = true
}
