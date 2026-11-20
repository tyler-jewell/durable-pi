# The studio's LLM endpoints behind Cloudflare Access. Only the two service tokens that need them may call them.
# Before this file, the reusable policy accepted any valid service token in the account.

variable "llm_service_token_zero_id" {
  type        = string
  description = "The service token the zero bootstrap presents to the LLM endpoints. Set in terraform.tfvars."
}

variable "llm_service_token_macbook_id" {
  type        = string
  description = "The service token the MacBook presents to the LLM endpoints. Set in terraform.tfvars."
}

variable "llm_macbook_hostname" {
  type        = string
  description = "The MacBook's LLM endpoint (served by the MacBook's tunnel). Set in terraform.tfvars."
}

# The reusable policy both LLM applications use. Narrowed from any_valid_service_token to two named tokens.
resource "cloudflare_zero_trust_access_policy" "llm_service_auth" {
  account_id = var.cloudflare_account_id
  name       = "dpi-mesh-service-auth"
  decision   = "non_identity"
  include = [
    { service_token = { token_id = var.llm_service_token_zero_id } },
    { service_token = { token_id = var.llm_service_token_macbook_id } },
  ]
  exclude = []
  require = []
}

resource "cloudflare_zero_trust_access_application" "llm_studio" {
  account_id                = var.cloudflare_account_id
  type                      = "self_hosted"
  name                      = "dpi-llm-studio"
  domain                    = var.llm_hostname
  session_duration          = "24h"
  app_launcher_visible      = false
  http_only_cookie_attribute = true
  service_auth_401_redirect = true
  allowed_idps              = []
  policies = [
    { id = cloudflare_zero_trust_access_policy.llm_service_auth.id, precedence = 1 },
  ]
}

resource "cloudflare_zero_trust_access_application" "llm_macbook" {
  account_id                = var.cloudflare_account_id
  type                      = "self_hosted"
  name                      = "dpi-llm-macbook-pro"
  domain                    = var.llm_macbook_hostname
  session_duration          = "24h"
  app_launcher_visible      = false
  http_only_cookie_attribute = true
  service_auth_401_redirect = true
  allowed_idps              = []
  policies = [
    { id = cloudflare_zero_trust_access_policy.llm_service_auth.id, precedence = 1 },
  ]
}
