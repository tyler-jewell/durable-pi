import { liveClient, pushBaseline } from "../src/artifacts-git.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const result = await pushBaseline(liveClient(root), process.env, true);
console.log(`${result.namespace}/${result.repo} ${result.head.slice(0, 12)} mirror=${result.mirrored}`);
if (!result.mirrored) console.log(result.mirrorDetail);
