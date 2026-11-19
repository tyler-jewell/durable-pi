variable "cloudflare_account_id" {
  description = "Cloudflare account ID (jewell-labs, NOT flagseeker)"
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "Zone ID for the DNS record (jewell-labs.com)"
  type        = string
}

variable "hostname" {
  description = "SSH hostname served by the tunnel"
  type        = string
  default     = "studio.jewell-labs.com"
}

variable "ssh_emails" {
  description = "Emails allowed to authenticate (Access maps the cert principal to the email PREFIX)"
  type        = list(string)
}

variable "service_token_id" {
  description = "ID (UUID) of the Access service token for the non-interactive lane. Managed outside Terraform (cf CLI / rotation script) because its client secret cannot be imported."
  type        = string
  sensitive   = true
}
