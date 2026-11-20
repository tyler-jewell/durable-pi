// Enablement rules for a rebuilt tool store. Discovery supplies the models. This file supplies which kinds are
// enabled, the selection mode, and how long the meter and team feed are kept. It names no model.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelKind } from "./models.js";
import type { SelectionMode, ToolStore } from "./tool-store.js";

export interface ToolPolicy {
  selectionMode: SelectionMode;
  enable: { mesh: ModelKind[]; cloud: ModelKind[] };
  retentionDays: { meter: number; teamFeed: number };
}

export function loadPolicy(path = join(dirname(fileURLToPath(import.meta.url)), "..", "policy.json")): ToolPolicy {
  return JSON.parse(readFileSync(path, "utf8")) as ToolPolicy;
}

/** Apply enablement from the policy. A kind listed for the tool's source is enabled; every other tool is not. */
export function applyPolicy(store: ToolStore, policy: ToolPolicy): void {
  store.selectionMode = policy.selectionMode;
  for (const tool of store.tools) {
    tool.enabled = policy.enable[tool.source].includes(tool.kind);
  }
}
