import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockFile } from "../src/store.js";

const dir = () => mkdtempSync(join(tmpdir(), "dpi-lock-"));

test("a fresh lock is taken and released", () => {
  const path = join(dir(), "db.lock");
  const unlock = lockFile(path);
  assert.ok(existsSync(path));
  unlock();
  assert.ok(!existsSync(path));
});

test("a stale lock from a dead pid is retaken", () => {
  const path = join(dir(), "db.lock");
  writeFileSync(path, "999999999 bogus");
  const unlock = lockFile(path); // must not throw
  unlock();
});

test("a lock whose pid was reused (a live, different process with a stale token) is retaken, not a block", () => {
  const path = join(dir(), "db.lock");
  // A stale lock after a container restart: its pid now belongs to some other live process, and the recorded start
  // token is gone. The old code blocked on kill(pid, 0) succeeding for the reused pid.
  const otherPid = process.ppid;
  assert.notEqual(otherPid, process.pid);
  writeFileSync(path, `${otherPid} bogus`);
  const unlock = lockFile(path); // must not throw
  unlock();
});

test("an old-format lock (pid only, no start token) is retaken", () => {
  const path = join(dir(), "db.lock");
  writeFileSync(path, String(process.pid));
  const unlock = lockFile(path);
  unlock();
});
