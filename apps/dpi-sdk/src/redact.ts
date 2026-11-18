// Scrub secrets from text before it is logged or streamed. This is hygiene and defense-in-depth,
// not a guarantee: the real protection is never putting valuable secrets in a public app. The
// caller passes the exact secret values it knows about (from config/env); the patterns below catch
// common credential shapes so a *new* token of a known shape is also scrubbed.

export const REDACTED = "[redacted]";

/** Common credential shapes. Keep conservative so ordinary text is never touched. */
const PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "Cloudflare API token", re: /\bcfat_[A-Za-z0-9_-]{8,}\b/g },
  { name: "OpenAI/Anthropic key", re: /\bsk-[A-Za-z0-9_-]{8,}\b/g },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: "DPI device token", re: /\bdpi_[A-Za-z0-9_-]{20,}\b/g },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "Bearer credential", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/g },
  { name: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  // Exact known values first, longest-first so a longer secret cannot leave a shorter prefix behind.
  const known = [...new Set(secrets)].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  for (const secret of known) out = out.split(secret).join(REDACTED);
  for (const { re } of PATTERNS) out = out.replace(re, REDACTED);
  return out;
}
