# Auth: set CLOUDFLARE_API_TOKEN (scoped token; see README for permissions).
# Account + zone come from variables (terraform.tfvars).

# ---- Tunnel (remotely-managed) ----
resource "cloudflare_tunnel" "studio" {
  account_id = var.cloudflare_account_id
  name       = "studio"
  config_src = "cloudflare"
}

# ---- DNS CNAME: studio.jewell-labs.com -> tunnel ----
resource "cloudflare_record" "studio_ssh" {
  zone_id = var.cloudflare_zone_id
  name    = "studio"
  type    = "CNAME"
  content = "${cloudflare_tunnel.studio.id}.cfargotunnel.com"
  proxied = true
}

# ---- Login method (email one-time PIN) ----
# GOTCHA: a fresh Zero Trust org may have NO login method; without this,
# the login page says "no login methods available".
resource "cloudflare_zero_trust_access_identity_provider" "otp" {
  account_id = var.cloudflare_account_id
  name       = "One-time PIN login"
  type       = "onetimepin"
}

# ---- Service token (agent / non-interactive lane) ----
# GOTCHA: bounded duration + rotate; never "forever".
resource "cloudflare_access_service_token" "agent" {
  account_id = var.cloudflare_account_id
  name       = "studio-ssh-agent"
  duration   = var.service_token_duration
}

# ---- Access application (SSH) ----
# GOTCHA: app_launcher_visible MUST be false for ssh apps, or post-login
# redirects land on the (disabled) App Launcher and confuse everyone.
resource "cloudflare_access_application" "studio_ssh" {
  account_id                = var.cloudflare_account_id
  name                      = "studio-ssh"
  domain                    = var.hostname
  type                      = "ssh"
  session_duration          = "24h"
  app_launcher_visible      = false
  auto_redirect_to_identity = false
}

# ---- Policy: emails OR service token ----
resource "cloudflare_access_policy" "studio_ssh" {
  account_id     = var.cloudflare_account_id
  application_id = cloudflare_access_application.studio_ssh.id
  name           = "studio-ssh-access"
  decision       = "allow"
  precedence     = 1

  dynamic "include" {
    for_each = var.ssh_emails
    content {
      email = [include.value]
    }
  }
  include {
    service_token = [cloudflare_access_service_token.agent.id]
  }
}

# ---- Per-app short-lived certificate CA ----
# GOTCHA: this is SEPARATE from the legacy account-level SSH CA. Without it,
# `cloudflared access ssh-gen` fails with "Please create a ca for application."
resource "cloudflare_zero_trust_access_short_lived_certificates" "studio_ssh" {
  account_id     = var.cloudflare_account_id
  application_id = cloudflare_access_application.studio_ssh.id
}

