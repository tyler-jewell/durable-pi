import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTeamFeed, notifyReady } from "../src/notify.js";

test("notifyReady appends to the shared team feed and loadTeamFeed reads it", () => {
  const dir = mkdtempSync(join(tmpdir(), "dpi-feed-"));
  const feed = join(dir, "team-feed.json");
  const prev = process.env.DPI_MCP_TEAM_FEED;
  process.env.DPI_MCP_TEAM_FEED = feed;
  try {
    assert.deepEqual(loadTeamFeed(), []);
    const entries = notifyReady({
      at: 1,
      kind: "capability-ready",
      capability: "studio-decision-clef-flash-q4-k-m",
      host: "studio",
      model: "Clef-Flash-Q4_K_M",
      purpose: ["jev-quality"],
      validated: { liveTest: "ok", endToEndMs: 42 },
      message: "validated and deployed",
    });
    assert.equal(entries.length, 1);
    assert.equal(loadTeamFeed()[0].capability, "studio-decision-clef-flash-q4-k-m");
    assert.equal(loadTeamFeed()[0].validated?.endToEndMs, 42);
  } finally {
    process.env.DPI_MCP_TEAM_FEED = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
