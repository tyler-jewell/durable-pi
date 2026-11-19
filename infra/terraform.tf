terraform {
  # The latest Terraform minor (style guide, Version Pinning).
  required_version = ">= 1.17"

  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
      # Still v4 on purpose. Moving to v5 renames these resources, and without `moved` blocks a plan destroys and
      # recreates the tunnel and the Access policy. The migration is in infra/README.md and needs the real state first.
      version = "~> 4.0"
    }
  }
}
