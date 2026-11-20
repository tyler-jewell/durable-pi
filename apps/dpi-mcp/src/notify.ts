// The team feed: the capability lifecycle's "tell the team when it's ready" channel.
// A readiness entry is appended to one shared JSON feed that any client — a settings UI,
// another agent, or a human — can read. The proof that a discovered host capability was
// validated, deployed and is ready lands here.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TeamFeedEntry {
  at: number;
  kind: "capability-ready" | "capability-deployed" | "note";
  capability?: string;
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
  const feed = loadTeamFeed();
  feed.push(entry);
  mkdirSync(join(homedir(), ".dpi-mcp"), { recursive: true });
  writeFileSync(FEED(), JSON.stringify(feed, null, 2) + "\n");
  return feed;
}
