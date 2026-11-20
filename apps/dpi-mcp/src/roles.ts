// The two roles a bearer token can grant on dpi-mcp. The agent role gets every tool a model needs. The admin role is
// the only one that gets the admin tools (Cloudflare inventory and billing, and the destructive and token tools).
// Tokens are compared in constant time, and an unknown token grants nothing.
import { timingSafeEqual } from "node:crypto";

export type Role = "agent" | "admin";

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The role a bearer token grants, or undefined when the token matches neither role. */
export function roleOf(bearer: string, agentToken: string, adminToken: string | undefined): Role | undefined {
  if (adminToken && same(bearer, adminToken)) return "admin";
  if (agentToken && same(bearer, agentToken)) return "agent";
  return undefined;
}
