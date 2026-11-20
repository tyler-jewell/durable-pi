// The team feed: readiness announcements that the team and any agent can read. Each entry is appended to one
// shared JSON feed. A settings UI, another agent, or a person reads it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadPolicy } from "./policy.js";

export interface TeamFeedEntry {
  at: number;
  kind: "ready" | "deployed" | "note";
  tool?: string;
  host?: string;
  model?: string;
  purpose?: string[];
  /** The validation evidence: host config checks + live test + a real end-to-end call. */
  validated?: Record<string, unknown>;
  message: string;
}

const FEED = () => process.env.DPI_MCP_TEAM_FEED ?? join(homedir(), ".dpi-mcp", "team-feed.json");

export function loadTeamFeed(): TeamFeedEntry[] {
  try {
    return JSON.parse(readFileSync(FEED(), "utf8")) as TeamFeedEntry[];
  } catch {
    return [];
  }
}

export function notifyReady(entry: TeamFeedEntry): TeamFeedEntry[] {
  const keepAfter = entry.at - loadPolicy().retentionDays.teamFeed * 24 * 60 * 60 * 1000;
  const feed = loadTeamFeed().filter((item) => item.at >= keepAfter);
  feed.push(entry);
  mkdirSync(join(homedir(), ".dpi-mcp"), { recursive: true });
  writeFileSync(FEED(), JSON.stringify(feed, null, 2) + "\n");
  return feed;
}
