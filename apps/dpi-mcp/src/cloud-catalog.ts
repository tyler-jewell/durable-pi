// Cloud discovery: the Cloudflare Workers AI catalog is the source of truth for cloud models, their kind and
// their prices. Nothing in this repo names a cloud model. The catalog is read at discovery time (`cf ai models
// list`), and every model's price is stored on its tool record.
//
// Kind comes from the provider's own description: a text-generation model whose description says it is a
// decision model (or System One-style) is a `decision` model, and every other text-generation model is `llm`.
import { execFileSync } from "node:child_process";
import { familyOf } from "./models.js";
import { kindTags, toolNameOf, type ModelTool, type ToolStore } from "./tool-store.js";

export interface Price {
  /** USD per million input tokens. */
  inPerM: number;
  /** USD per million output tokens. */
  outPerM: number;
  /** USD per million cached input tokens, when the catalog lists one. */
  cachedInPerM?: number;
}

export interface CatalogModel {
  name: string;
  kind: "llm" | "decision";
  description: string;
  price?: Price;
  /** The hosted window, from the catalog's context_window property (a string in the catalog). */
  contextWindow?: number;
}

const DECISION = /decision model|system one/i;

/** Turn the catalog's JSON into text-generation models. Other tasks (images, speech, embeddings) are not models
 *  this system routes to, so they are skipped. A model without a per-token price is kept, unpriced. */
export function parseCatalog(raw: unknown): CatalogModel[] {
  if (!Array.isArray(raw)) return [];
  const out: CatalogModel[] = [];
  for (const m of raw as Record<string, unknown>[]) {
    const task = (m.task as { name?: string } | undefined)?.name;
    const name = typeof m.name === "string" ? m.name : "";
    if (task !== "Text Generation" || !name) continue;
    const description = typeof m.description === "string" ? m.description : "";
    const props = Array.isArray(m.properties) ? (m.properties as { property_id?: string; value?: unknown }[]) : [];
    const priceProp = props.find((p) => p.property_id === "price");
    const ctxProp = props.find((p) => p.property_id === "context_window");
    const contextWindow = Number(ctxProp?.value);
    out.push({
      name,
      kind: DECISION.test(description) ? "decision" : "llm",
      description,
      price: parsePrice(priceProp?.value),
      contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined,
    });
  }
  return out;
}

/** Read the per-token rates from the catalog's price list. Returns undefined when there is no token price. */
export function parsePrice(value: unknown): Price | undefined {
  if (!Array.isArray(value)) return undefined;
  let inPerM: number | undefined;
  let outPerM: number | undefined;
  let cachedInPerM: number | undefined;
  for (const row of value as { unit?: string; price?: number; currency?: string }[]) {
    if (row.currency !== "USD" || typeof row.price !== "number") continue;
    const unit = (row.unit ?? "").toLowerCase();
    if (unit.includes("per m") && unit.includes("cached input")) cachedInPerM = row.price;
    else if (unit.includes("per m") && unit.includes("input")) inPerM = row.price;
    else if (unit.includes("per m") && unit.includes("output")) outPerM = row.price;
  }
  if (inPerM === undefined || outPerM === undefined) return undefined;
  return cachedInPerM === undefined ? { inPerM, outPerM } : { inPerM, outPerM, cachedInPerM };
}

/** The USD cost of one call from its tokens. Undefined when the model has no price: an unpriced model is
 *  never reported as $0. */
export function tokenCostUsd(price: Price | undefined, inToks: number, outToks: number): number | undefined {
  if (!price) return undefined;
  return (inToks * price.inPerM + outToks * price.outPerM) / 1_000_000;
}

/** Read the live catalog with the Cloudflare CLI (`cf ai models list`), one page at a time, filtered to text
 *  generation and paged until a page comes back empty, so a long catalog is never read partially. The CLI may
 *  print a status line before the JSON, so each parse starts at the first `[`. */
export function fetchCatalog(bin = process.env.DPI_MCP_CF ?? "cf", timeoutMs = 60_000, perPage = 100, maxPages = 20): CatalogModel[] {
  const models: CatalogModel[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const raw = execFileSync(bin, ["ai", "models", "list", "--task", "Text Generation", "--per-page", String(perPage), "--page", String(page)], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    const rows = JSON.parse(raw.slice(raw.indexOf("["))) as unknown[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    models.push(...parseCatalog(rows));
    if (rows.length < perPage) break;
  }
  return models;
}

/** Add or refresh one cloud tool per catalog model. A tool a person enabled stays enabled, and its tags stay.
 *  Prices and the served window always come from the latest catalog. A new model is disabled until enabled. */
export function syncCloudTools(store: ToolStore, models: CatalogModel[], address: string, now = Date.now()): { added: number; refreshed: number } {
  let added = 0;
  let refreshed = 0;
  for (const m of models) {
    const name = toolNameOf("cloudflare", m.name);
    const existing = store.tools.find((t) => t.name === name);
    const tool: ModelTool = {
      name,
      source: "cloud",
      host: "cloudflare",
      address,
      model: m.name,
      kind: m.kind,
      transport: "cloudflare-workers-ai",
      family: familyOf(m.name),
      description: m.description.slice(0, 400) || "Cloudflare Workers AI model",
      tags: [...new Set([...kindTags(m.kind), ...(existing?.tags ?? []).filter((t) => t !== "chat" && t !== "decision")])],
      enabled: existing?.enabled ?? false,
      servedContext: m.contextWindow,
      pricing: m.price,
      secretEnv: "CLOUDFLARE_API_KEY",
      discoveredAt: existing?.discoveredAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt,
    };
    if (existing) {
      store.tools = store.tools.map((t) => (t.name === name ? tool : t));
      refreshed++;
    } else {
      store.tools.push(tool);
      added++;
    }
  }
  return { added, refreshed };
}
