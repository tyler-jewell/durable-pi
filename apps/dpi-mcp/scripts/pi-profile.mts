// Write pi's agent profile for this mesh, from the registry: every enabled local chat model, with the window its
// server actually runs with. Nothing is hand-written and no secret is written.
//
//   npx tsx scripts/pi-profile.mts <dir>      # then: set -a; . <dir>/env.sh; PI_CODING_AGENT_DIR=<dir> pi ...
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadRegistry } from "../src/capabilities.js";
import { buildPiProfile } from "../src/pi-profile.js";
import { loadMeshConfig } from "../src/mesh-config.js";

const dir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: pi-profile.mts <dir>");
const profile = buildPiProfile(loadRegistry(), loadMeshConfig().hosts);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "models.json"), JSON.stringify(profile.models, null, 2) + "\n", { mode: 0o600 });
writeFileSync(join(dir, "env.sh"), profile.envSh, { mode: 0o600 });
chmodSync(join(dir, "env.sh"), 0o600);
const models = Object.values(profile.models.providers).flatMap((p) => (p as { models: { id: string; contextWindow: number }[] }).models);
console.log(`pi profile in ${dir}: ${models.length} model(s)`);
for (const m of models) console.log(`  ${m.id}  served window ${m.contextWindow}`);
for (const s of profile.skipped) console.log(`  skipped ${s.id}: ${s.reason}`);
