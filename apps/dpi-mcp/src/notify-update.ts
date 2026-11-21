// Tells every subscribed phone that the Artifacts main branch moved. The VAPID keys and the phone subscriptions live in
// the local device state (~/.dpi); nothing here is printed except counts and HTTP statuses.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isSha, parseLog, updateNotice, type Commit } from "./update-notice.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../../..");

interface WebPush {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(subscription: unknown, payload: string): Promise<{ statusCode: number }>;
}
// The web-push library is the one the hub already uses; it lives in the playground's dependencies.
const webpush = createRequire(import.meta.url)(join(here, "../../dpi-playground/node_modules/web-push")) as WebPush;

interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Commits from `from` to `to` in this checkout. Without a `from` this checkout knows, the last ten commits. */
export function changelog(from: string, to: string, cwd = ROOT): Commit[] {
  const range = isSha(from) ? [`${from}..${to}`] : ["-n", "10", to];
  try {
    return parseLog(execFileSync("git", ["log", "--format=%H%x09%s", ...range], { cwd, encoding: "utf8" }));
  } catch {
    return [];
  }
}

export interface NotifyResult {
  sent: number;
  statuses: number[];
  commits: number;
  reason?: string;
  notice?: { title: string; body: string; url: string };
}

/** Send one notice to every stored subscription. A dead endpoint (404, 410) is removed from the store. */
export async function notifyUpdate(input: { from: string; to: string; repo?: string; home?: string }): Promise<NotifyResult> {
  const home = input.home ?? process.env.DPI_HOME ?? join(homedir(), ".dpi");
  if (!isSha(input.to) || input.to === input.from) return { sent: 0, statuses: [], commits: 0, reason: "no new commit" };
  const keysFile = join(home, "vapid.json");
  const subsFile = join(home, "push-subscriptions.json");
  if (!existsSync(keysFile)) return { sent: 0, statuses: [], commits: 0, reason: "no VAPID keys" };
  if (!existsSync(subsFile)) return { sent: 0, statuses: [], commits: 0, reason: "no phone is subscribed" };

  const commits = changelog(input.from, input.to);
  const notice = updateNotice(input.repo ?? "durable-pi", commits, input.from, input.to);
  const keys = JSON.parse(readFileSync(keysFile, "utf8")) as { publicKey: string; privateKey: string; subject: string };
  webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);

  let subs = JSON.parse(readFileSync(subsFile, "utf8")) as Subscription[];
  const statuses: number[] = [];
  for (const sub of [...subs]) {
    try {
      const sent = await webpush.sendNotification(sub, JSON.stringify(notice));
      statuses.push(sent.statusCode);
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode ?? 0;
      statuses.push(status);
      if (status === 404 || status === 410) subs = subs.filter((item) => item.endpoint !== sub.endpoint);
    }
  }
  writeFileSync(subsFile, JSON.stringify(subs, null, 2) + "\n", { mode: 0o600 });
  chmodSync(subsFile, 0o600);
  return { sent: statuses.filter((s) => s >= 200 && s < 300).length, statuses, commits: commits.length, notice };
}
