import { liveClient, pushBaseline } from "../src/artifacts-git.js";
import { notifyUpdate } from "../src/notify-update.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const result = await pushBaseline(liveClient(root), process.env, true);
console.log(`${result.namespace}/${result.repo} ${result.head.slice(0, 12)} mirror=${result.mirrored}`);
if (!result.mirrored) console.log(result.mirrorDetail);
const notice = await notifyUpdate({ from: result.previous, to: result.head });
console.log(`notify: sent=${notice.sent} subscriptions=${notice.statuses.length} commits=${notice.commits}${notice.reason ? ` (${notice.reason})` : ""}`);
