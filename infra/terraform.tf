terraform {
  required_version = ">= 1.17"

  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
      # v5: the v4 tunnel/access resources are renamed, and the tunnel no longer requires a secret.
      version = "~> 5.0"
    }
  }

  # State lives in R2 (private bucket). Credentials come from the environment:
  # AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN (the R2 API token's three values).
  backend "s3" {
    bucket = "durable-pi-terraform-state"
    key    = "terraform.tfstate"
    endpoints = {
      s3 = "https://09f27fe672991450d128a652b5fb4d73.r2.cloudflarestorage.com"
    }
    region                      = "auto"
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }
}
