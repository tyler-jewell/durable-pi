# Auth: set CLOUDFLARE_API_TOKEN (scoped token; see README for permissions).
# Account + zone come from variables (terraform.tfvars).

# ---- Tunnel (remotely-managed) ----
resource "cloudflare_zero_trust_tunnel_cloudflared" "studio" {
  account_id = var.cloudflare_account_id
  name       = "studio"
  config_src = "cloudflare"
}

# The connector token is a separate data source in v5 (the resource no longer exports it).
data "cloudflare_zero_trust_tunnel_cloudflared_token" "studio" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.studio.id
}

# ---- DNS CNAME: studio.jewell-labs.com -> tunnel ----
resource "cloudflare_dns_record" "studio_ssh" {
  zone_id = var.cloudflare_zone_id
  name    = "studio"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.studio.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

# ---- Login method (email one-time PIN) ----
resource "cloudflare_zero_trust_access_identity_provider" "otp" {
  account_id = var.cloudflare_account_id
  name       = "One-time PIN login"
  type       = "onetimepin"
  config = {}
}

# ---- Access application (SSH), with its policy nested (v5 moved policies into the app) ----
resource "cloudflare_zero_trust_access_application" "studio_ssh" {
  account_id                  = var.cloudflare_account_id
  type                        = "ssh"
  domain                      = var.hostname
  session_duration            = "24h"
  app_launcher_visible        = false
  auto_redirect_to_identity   = false

  policies = [
    {
      name       = "studio-ssh-access"
      decision   = "allow"
      precedence = 1
      include = concat(
        [for e in var.ssh_emails : { email = { email = e } }],
        [{ service_token = { token_id = var.service_token_id } }],
      )
      exclude = []
      require = []
    },
  ]
}

# ---- Per-app short-lived certificate CA ----
resource "cloudflare_zero_trust_access_short_lived_certificate" "studio_ssh" {
  account_id = var.cloudflare_account_id
  app_id     = cloudflare_zero_trust_access_application.studio_ssh.id
}
