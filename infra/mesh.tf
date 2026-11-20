# The studio's mesh endpoints, all through Cloudflare Tunnel and Access. No Tailscale.
# Replaces `tailscale serve`, which published the mesh MCP endpoint on the tailnet only.

variable "llm_hostname" {
  type        = string
  description = "The studio's LLM endpoint (its tunnel rule points at localhost:8080). Set in terraform.tfvars."
}

variable "mesh_hostname" {
  type        = string
  description = "The studio's mesh MCP endpoint (its tunnel rule points at localhost:8464). Set in terraform.tfvars."
}

variable "mesh_service_token_id" {
  type        = string
  description = "The service token the MacBook's mesh-health client presents to mesh_hostname. Set in terraform.tfvars."
}

# ---- Tunnel ingress: every hostname this tunnel serves. Terraform owns the whole list, so every rule is here. ----
# The SSH and LLM rules are the ones that exist today; the mesh rule is new.
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "studio" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.studio.id
  config = {
    ingress = [
      { hostname = var.hostname, service = "ssh://localhost:2222" },
      { hostname = var.llm_hostname, service = "http://localhost:8080" },
      { hostname = var.mesh_hostname, service = "http://localhost:8464" },
      { service = "http_status:404" },
    ]
  }
}

# ---- DNS for the mesh MCP endpoint ----
resource "cloudflare_dns_record" "mesh" {
  zone_id = var.cloudflare_zone_id
  name    = var.mesh_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.studio.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

# ---- Access for the mesh MCP endpoint: the owner's named identities, or the MacBook's service token. Nothing else. ----
resource "cloudflare_zero_trust_access_application" "mesh" {
  account_id           = var.cloudflare_account_id
  type                 = "self_hosted"
  name                 = "dpi-mesh-mcp"
  domain               = var.mesh_hostname
  session_duration     = "24h"
  app_launcher_visible = false

  policies = [
    {
      name       = "mesh-owner"
      decision   = "allow"
      precedence = 1
      include    = [for e in var.ssh_emails : { email = { email = e } }]
      exclude    = []
      require    = []
    },
    {
      name       = "mesh-mbp-service-token"
      decision   = "non_identity"
      precedence = 2
      include    = [{ service_token = { token_id = var.mesh_service_token_id } }]
      exclude    = []
      require    = []
    },
  ]
}
