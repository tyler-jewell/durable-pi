// Send one Web Push to every subscription the hub has stored. Keys stay in the local vapid file.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const webpush = require("../apps/dpi-playground/node_modules/web-push") as {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(sub: unknown, payload: string): Promise<{ statusCode: number }>;
};

const home = process.env.DPI_HOME ?? join(homedir(), ".dpi");
const keys = JSON.parse(readFileSync(join(home, "vapid.json"), "utf8")) as { publicKey: string; privateKey: string; subject: string };
const subs = JSON.parse(readFileSync(process.env.DPI_PUSH_FILE ?? join(home, "push-subscriptions.json"), "utf8")) as { endpoint: string; keys: { p256dh: string; auth: string } }[];
const title = process.argv[2] ?? "Durable Pi";
const body = process.argv[3] ?? "A message is waiting.";
webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
if (!subs.length) throw new Error("no push subscription is stored");
for (const sub of subs) {
  const sent = await webpush.sendNotification(sub, JSON.stringify({ title, body, url: "/" }));
  console.log(`sent ${sent.statusCode}`);
}
