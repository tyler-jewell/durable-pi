import { c as clearBlobCache, d as hashKey, i as isKeyPinned, l as evictBlob, n as HAS_OBJECTS_PIN_MS, o as pinHashes, r as STREAM_IDLE_LEASE_MS, s as pinObjects, t as RecordingStorage, u as getBlobBytes } from "./testing-recording-DSCOdDiW.js";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
// src/errors.ts
function createWorkspaceError(code, message, path) {
	const named = path === void 0 || message.endsWith(path) ? message : `${message}: ${path}`;
	const error = new Error(named);
	error.name = "WorkspaceFsError";
	error.code = code;
	error.path = path;
	return error;
}
function invalidPath(path, reason) {
	return createWorkspaceError("EINVAL", `Invalid path (${reason})`, path);
}
// src/path.ts
function canonicalizePath(path) {
	if (path.length === 0) throw invalidPath(path, "empty");
	if (!path.startsWith("/")) throw invalidPath(path, "must be absolute");
	if (path.includes("\0")) throw invalidPath(path, "contains NUL byte");
	const parts = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) throw invalidPath(path, "escapes root");
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	const canonical = parts.length === 0 ? "/" : `/${parts.join("/")}`;
	const name = parts.length === 0 ? "" : parts[parts.length - 1];
	const parentParts = parts.slice(0, -1);
	return {
		path: canonical,
		parts,
		name,
		parentPath: parts.length === 0 ? void 0 : parentParts.length === 0 ? "/" : `/${parentParts.join("/")}`
	};
}
// src/rev.ts
function incrementRev(db) {
	const row = db.one("UPDATE vfs_meta SET v = v + 1 WHERE k = 'rev' RETURNING v");
	if (row === void 0) throw new Error("vfs_meta.rev row missing; was initializeSchema run?");
	return row.v;
}
// src/fs/mount-guard.ts
const cache = /* @__PURE__ */ new WeakMap();
function invalidateReadOnlyMountCache(db) {
	cache.delete(db);
}
function loadReadOnlyRoots(db) {
	const roots = db.all("SELECT root FROM _vfs_mounts WHERE mode = 'read-only'").map((r) => r.root);
	cache.set(db, roots);
	return roots;
}
function getReadOnlyMountRoots(db) {
	const cached = cache.get(db);
	if (cached !== void 0) return cached;
	return loadReadOnlyRoots(db);
}
function isAtOrBelowRoot(path, root) {
	return root === "/" || path === root || path.startsWith(`${root}/`);
}
function overlapsRoot(path, root) {
	return isAtOrBelowRoot(path, root) || root.startsWith(`${path}/`);
}
function assertNotReadOnly(db, path) {
	const roots = getReadOnlyMountRoots(db);
	if (roots.length === 0) return;
	for (const root of roots) if (overlapsRoot(path, root)) throw createWorkspaceError("EROFS", `read-only mount at ${root}: cannot modify`, path);
}
function assertNotInReadOnlyMount(db, path) {
	const roots = getReadOnlyMountRoots(db);
	for (const root of roots) if (isAtOrBelowRoot(path, root)) throw createWorkspaceError("EROFS", `read-only mount at ${root}: cannot modify`, path);
}
function readOnlyRootFor(db, path) {
	const roots = getReadOnlyMountRoots(db);
	for (const root of roots) if (overlapsRoot(path, root)) return root;
}
// src/schema/core.ts
const SCHEMA_VERSION = 10;
const ROOT_INODE = 1;
const CORE_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS vfs_meta (
    k TEXT PRIMARY KEY,
    v INTEGER NOT NULL
  )`,
	`CREATE TABLE IF NOT EXISTS vfs_nodes (
    inode         INTEGER PRIMARY KEY AUTOINCREMENT,
    type          TEXT    NOT NULL CHECK(type IN ('file','dir','symlink')),
    mode          INTEGER NOT NULL DEFAULT 493,
    mtime         INTEGER NOT NULL,
    rev           INTEGER NOT NULL DEFAULT 0,
    mount_root    TEXT,
    stub_size     INTEGER,
    manifest_hash BLOB,
    link_target   TEXT,
    size          INTEGER NOT NULL DEFAULT 0
  )`,
	`CREATE TABLE IF NOT EXISTS vfs_dirents (
    parent_inode INTEGER NOT NULL,
    name         TEXT    NOT NULL,
    child_inode  INTEGER NOT NULL,
    PRIMARY KEY (parent_inode, name)
  ) WITHOUT ROWID`,
	`CREATE INDEX IF NOT EXISTS vfs_dirents_by_child ON vfs_dirents(child_inode)`,
	`CREATE INDEX IF NOT EXISTS vfs_nodes_by_rev ON vfs_nodes(rev)`,
	`CREATE INDEX IF NOT EXISTS vfs_nodes_by_manifest_hash
    ON vfs_nodes(manifest_hash) WHERE manifest_hash IS NOT NULL`,
	`CREATE TABLE IF NOT EXISTS vfs_blobs (
    hash      BLOB    PRIMARY KEY,
    size      INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  )`,
	`CREATE TABLE IF NOT EXISTS vfs_blob_bytes (
    hash  BLOB PRIMARY KEY REFERENCES vfs_blobs(hash) ON DELETE CASCADE,
    bytes BLOB NOT NULL
  )`,
	`CREATE TABLE IF NOT EXISTS vfs_chunks (
    inode INTEGER NOT NULL,
    idx   INTEGER NOT NULL,
    hash  BLOB    NOT NULL,
    size  INTEGER NOT NULL,
    PRIMARY KEY (inode, idx)
  ) WITHOUT ROWID`,
	`CREATE INDEX IF NOT EXISTS vfs_chunks_by_hash ON vfs_chunks(hash)`
];
// src/schema/migrations.ts
function v1_to_v2_add_mounts_mode(db) {
	db.run(`ALTER TABLE _vfs_mounts
       ADD COLUMN mode TEXT NOT NULL DEFAULT 'read-only'
       CHECK(mode IN ('read-only', 'read-write'))`);
}
function v2_to_v3_add_size_column(db) {
	if (!db.all("PRAGMA table_info(vfs_nodes)").some((column) => column.name === "size")) db.run("ALTER TABLE vfs_nodes ADD COLUMN size INTEGER NOT NULL DEFAULT 0");
	db.run(`UPDATE vfs_nodes
        SET size = COALESCE(
          (SELECT SUM(size) FROM vfs_chunks WHERE vfs_chunks.inode = vfs_nodes.inode),
          0
        )
      WHERE type = 'file'`);
}
function v3_to_v4_watermark_backend_column(db) {
	db.run(`ALTER TABLE _vfs_watermark RENAME TO _vfs_watermark_v3`);
	db.run(`CREATE TABLE _vfs_watermark (
       k       TEXT    NOT NULL,
       backend TEXT    NOT NULL DEFAULT 'default',
       v       INTEGER NOT NULL,
       PRIMARY KEY (k, backend)
     )`);
	db.run(`INSERT INTO _vfs_watermark (k, backend, v)
       SELECT k, 'default', v FROM _vfs_watermark_v3`);
	db.run(`DROP TABLE _vfs_watermark_v3`);
}
function v4_to_v5_without_rowid(db) {
	db.run(`ALTER TABLE vfs_dirents RENAME TO vfs_dirents_v4`);
	db.run(`CREATE TABLE vfs_dirents (
       parent_inode INTEGER NOT NULL,
       name         TEXT    NOT NULL,
       child_inode  INTEGER NOT NULL,
       PRIMARY KEY (parent_inode, name)
     ) WITHOUT ROWID`);
	db.run(`INSERT INTO vfs_dirents (parent_inode, name, child_inode)
       SELECT parent_inode, name, child_inode FROM vfs_dirents_v4`);
	db.run(`DROP TABLE vfs_dirents_v4`);
	db.run(`CREATE INDEX vfs_dirents_by_child ON vfs_dirents(child_inode)`);
	db.run(`ALTER TABLE vfs_chunks RENAME TO vfs_chunks_v4`);
	db.run(`CREATE TABLE vfs_chunks (
       inode INTEGER NOT NULL,
       idx   INTEGER NOT NULL,
       hash  BLOB    NOT NULL,
       size  INTEGER NOT NULL,
       PRIMARY KEY (inode, idx)
     ) WITHOUT ROWID`);
	db.run(`INSERT INTO vfs_chunks (inode, idx, hash, size)
       SELECT inode, idx, hash, size FROM vfs_chunks_v4`);
	db.run(`DROP TABLE vfs_chunks_v4`);
	db.run(`CREATE INDEX vfs_chunks_by_hash ON vfs_chunks(hash)`);
}
function v5_to_v6_push_cursor(db) {
	db.run(`CREATE TABLE IF NOT EXISTS _vfs_push_cursor (
       k       TEXT    NOT NULL CHECK(k = 'push'),
       backend TEXT    NOT NULL DEFAULT 'default',
       rev     INTEGER NOT NULL DEFAULT 0,
       path    TEXT,
       PRIMARY KEY (k, backend)
     )`);
	db.run(`INSERT OR IGNORE INTO _vfs_push_cursor (k, backend, rev, path)
       SELECT 'push', backend, v, NULL
       FROM _vfs_watermark
       WHERE k = 'pushRev'`);
}
function v6_to_v7_sync_operations(db) {
	db.run(`CREATE TABLE IF NOT EXISTS _vfs_sync_operations (
       backend             TEXT    NOT NULL,
       direction           TEXT    NOT NULL CHECK (direction IN ('pull', 'push')),
       generation          TEXT    NOT NULL,
       status              TEXT    NOT NULL CHECK (
                             status IN ('capturing', 'pending', 'failed', 'lost')
                           ),
       target_rev          INTEGER,
       target_path         TEXT,
       runtime_id          TEXT,
       mode                TEXT    CHECK (mode IN ('entries', 'pack')),
       block_after_rev     INTEGER,
       block_after_path    TEXT,
       block_started_at    INTEGER,
       internal_max_entries INTEGER NOT NULL,
       internal_max_bytes  INTEGER NOT NULL,
       created_at          INTEGER NOT NULL,
       updated_at          INTEGER NOT NULL,
       last_error          TEXT,
       PRIMARY KEY (backend, direction)
     )`);
	db.run(`CREATE TABLE IF NOT EXISTS _vfs_sync_skips (
       backend    TEXT    NOT NULL,
       direction  TEXT    NOT NULL CHECK (direction IN ('pull', 'push')),
       generation TEXT    NOT NULL,
       path       TEXT    NOT NULL,
       reason     TEXT    NOT NULL,
       at         INTEGER NOT NULL,
       PRIMARY KEY (backend, direction, generation, path)
     )`);
}
function v7_to_v8_changes_op_rev_index(db) {
	db.run(`CREATE INDEX IF NOT EXISTS vfs_changes_by_op_rev ON vfs_changes(op, rev)`);
}
function v8_to_v9_changes_prior(db) {
	if (!db.all("PRAGMA table_info(vfs_changes)").some((column) => column.name === "prior")) db.run("ALTER TABLE vfs_changes ADD COLUMN prior TEXT");
}
function v9_to_v10_add_mounts_version(db) {
	if (!db.all("PRAGMA table_info(_vfs_mounts)").some((column) => column.name === "version")) db.run("ALTER TABLE _vfs_mounts ADD COLUMN version TEXT");
}
const MIGRATIONS = [
	{
		from: 1,
		to: 2,
		migrator: v1_to_v2_add_mounts_mode
	},
	{
		from: 2,
		to: 3,
		migrator: v2_to_v3_add_size_column
	},
	{
		from: 3,
		to: 4,
		migrator: v3_to_v4_watermark_backend_column
	},
	{
		from: 4,
		to: 5,
		migrator: v4_to_v5_without_rowid
	},
	{
		from: 5,
		to: 6,
		migrator: v5_to_v6_push_cursor
	},
	{
		from: 6,
		to: 7,
		migrator: v6_to_v7_sync_operations
	},
	{
		from: 7,
		to: 8,
		migrator: v7_to_v8_changes_op_rev_index
	},
	{
		from: 8,
		to: 9,
		migrator: v8_to_v9_changes_prior
	},
	{
		from: 9,
		to: 10,
		migrator: v9_to_v10_add_mounts_version
	}
];
function runMigrations(db, current, target) {
	let version = current;
	while (version < target) {
		const next = MIGRATIONS.find((m) => m.from === version);
		if (next === void 0) throw new Error(`dofs schema: no migration registered for v${version} -> v${target}`);
		next.migrator(db);
		version = next.to;
	}
	return version;
}
// src/schema/sync.ts
const SYNC_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS vfs_manifests (
    hash      BLOB    PRIMARY KEY,
    size      INTEGER NOT NULL,
    encoded   BLOB    NOT NULL,
    last_seen INTEGER NOT NULL DEFAULT 0
  )`,
	`CREATE TABLE IF NOT EXISTS vfs_changes (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    rev   INTEGER NOT NULL,
    path  TEXT    NOT NULL,
    op    TEXT    NOT NULL CHECK(op IN ('delete')),
    prior TEXT
  )`,
	`CREATE INDEX IF NOT EXISTS vfs_changes_by_rev ON vfs_changes(rev)`,
	`CREATE INDEX IF NOT EXISTS vfs_changes_by_path ON vfs_changes(path, id DESC)`,
	`CREATE INDEX IF NOT EXISTS vfs_changes_by_op_rev ON vfs_changes(op, rev)`,
	`CREATE TABLE IF NOT EXISTS _vfs_watermark (
    k       TEXT    NOT NULL,
    backend TEXT    NOT NULL DEFAULT 'default',
    v       INTEGER NOT NULL,
    PRIMARY KEY (k, backend)
  )`,
	`CREATE TABLE IF NOT EXISTS _vfs_fetch_cursor (
    k       TEXT    NOT NULL CHECK(k = 'fetch'),
    backend TEXT    NOT NULL DEFAULT 'default',
    path    TEXT,
    PRIMARY KEY (k, backend)
  )`,
	`CREATE TABLE IF NOT EXISTS _vfs_push_cursor (
    k       TEXT    NOT NULL CHECK(k = 'push'),
    backend TEXT    NOT NULL DEFAULT 'default',
    rev     INTEGER NOT NULL DEFAULT 0,
    path    TEXT,
    PRIMARY KEY (k, backend)
  )`,
	`CREATE TABLE IF NOT EXISTS _vfs_sync_operations (
    backend             TEXT    NOT NULL,
    direction           TEXT    NOT NULL CHECK (direction IN ('pull', 'push')),
    generation          TEXT    NOT NULL,
    status              TEXT    NOT NULL CHECK (
                          status IN ('capturing', 'pending', 'failed', 'lost')
                        ),
    target_rev          INTEGER,
    target_path         TEXT,
    runtime_id          TEXT,
    mode                TEXT    CHECK (mode IN ('entries', 'pack')),
    block_after_rev     INTEGER,
    block_after_path    TEXT,
    block_started_at    INTEGER,
    internal_max_entries INTEGER NOT NULL,
    internal_max_bytes  INTEGER NOT NULL,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    last_error          TEXT,
    PRIMARY KEY (backend, direction)
  )`,
	`CREATE TABLE IF NOT EXISTS _vfs_sync_skips (
    backend    TEXT    NOT NULL,
    direction  TEXT    NOT NULL CHECK (direction IN ('pull', 'push')),
    generation TEXT    NOT NULL,
    path       TEXT    NOT NULL,
    reason     TEXT    NOT NULL,
    at         INTEGER NOT NULL,
    PRIMARY KEY (backend, direction, generation, path)
  )`,
	`CREATE TABLE IF NOT EXISTS _vfs_mounts (
    root    TEXT PRIMARY KEY,
    kind    TEXT NOT NULL,
    indexed INTEGER NOT NULL DEFAULT 0,
    mode    TEXT NOT NULL DEFAULT 'read-only'
            CHECK(mode IN ('read-only', 'read-write')),
    version TEXT
  )`
];
// src/schema/index.ts
function initializeSchema(db, now) {
	db.transactionSync(() => {
		for (const statement of CORE_STATEMENTS) db.run(statement);
		for (const statement of SYNC_STATEMENTS) db.run(statement);
		const onDiskVersion = db.one("SELECT v FROM vfs_meta WHERE k = ?", "schema_version")?.v ?? 0;
		if (onDiskVersion > 10) throw createWorkspaceError("EIO", `Unsupported workspace filesystem schema version ${onDiskVersion}`);
		if (onDiskVersion > 0 && onDiskVersion < 10) runMigrations(db, onDiskVersion, 10);
		db.run("INSERT OR IGNORE INTO vfs_meta (k, v) VALUES (?, ?)", "schema_version", 10);
		db.run("UPDATE vfs_meta SET v = ? WHERE k = ?", 10, "schema_version");
		db.run("INSERT OR IGNORE INTO vfs_meta (k, v) VALUES (?, ?)", "rev", 1);
		db.run("INSERT OR IGNORE INTO _vfs_watermark (k, backend, v) VALUES (?, 'default', ?)", "pushRev", 0);
		db.run("INSERT OR IGNORE INTO _vfs_watermark (k, backend, v) VALUES (?, 'default', ?)", "fetchRev", 0);
		db.run("INSERT OR IGNORE INTO _vfs_fetch_cursor (k, backend, path) VALUES (?, 'default', ?)", "fetch", null);
		db.run("INSERT OR IGNORE INTO _vfs_push_cursor (k, backend, rev, path) VALUES (?, 'default', ?, ?)", "push", 0, null);
		db.run(`INSERT OR IGNORE INTO vfs_nodes
        (inode, type, mode, mtime, rev)
        VALUES (?, 'dir', ?, ?, 0)`, 1, 493, now());
	});
}
// src/fs/resolveCache.ts
const NEGATIVE = -1;
const MAX_ENTRIES = 8192;
const caches$1 = /* @__PURE__ */ new WeakMap();
function cacheFor$1(db) {
	let cache = caches$1.get(db);
	if (cache === void 0) {
		cache = /* @__PURE__ */ new Map();
		caches$1.set(db, cache);
	}
	return cache;
}
function lookupResolveCache(db, canonicalPath) {
	const cache = cacheFor$1(db);
	const value = cache.get(canonicalPath);
	if (value === void 0) return;
	cache.delete(canonicalPath);
	cache.set(canonicalPath, value);
	return value === NEGATIVE ? { kind: "negative" } : {
		kind: "inode",
		inode: value
	};
}
function storeResolveCache(db, canonicalPath, inode) {
	if (db.inTransaction) return;
	const cache = cacheFor$1(db);
	cache.set(canonicalPath, inode === null ? NEGATIVE : inode);
	while (cache.size > MAX_ENTRIES) {
		const oldest = cache.keys().next();
		if (oldest.done === true) break;
		cache.delete(oldest.value);
	}
}
function invalidateResolveExact(db, canonicalPath) {
	caches$1.get(db)?.delete(canonicalPath);
}
function invalidateResolveSubtree(db, canonicalPath) {
	const cache = caches$1.get(db);
	if (cache === void 0 || cache.size === 0) return;
	if (canonicalPath === "/") {
		cache.clear();
		return;
	}
	cache.delete(canonicalPath);
	const prefix = `${canonicalPath}/`;
	for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}
// src/fs/resolve.ts
const MAX_SYMLINK_FOLLOWS$2 = 40;
function resolveInode(db, path, options = {}) {
	const followFinal = options.followSymlinks !== false;
	const { parts, path: canonical } = canonicalizePath(path);
	if (!followFinal || db.inTransaction) return resolveParts(db, parts, followFinal, 0);
	const hit = lookupResolveCache(db, canonical);
	if (hit !== void 0) {
		if (hit.kind === "negative") return null;
		const node = readNode(db, hit.inode);
		if (node !== null) return toResolved(node);
	}
	const cte = resolveViaCte(db, parts);
	if (cte.kind === "symlink") return resolveParts(db, parts, followFinal, 0);
	storeResolveCache(db, canonical, cte.node === null ? null : cte.node.inode);
	return cte.node;
}
function resolveInodeWithoutSymlinks(db, path) {
	const { parts } = canonicalizePath(path);
	const resolution = resolveViaCte(db, parts);
	return resolution.kind === "resolved" ? resolution.node : null;
}
function resolveViaCte(db, parts) {
	const rows = db.all(`WITH RECURSIVE
       segs(level, name) AS (
         SELECT key, value FROM json_each(?)
       ),
       walk(level, inode, type, mode, mtime, size, link_target) AS (
         SELECT 0, n.inode, n.type, n.mode, n.mtime, n.size, n.link_target
           FROM vfs_nodes n
          WHERE n.inode = ?
         UNION ALL
         SELECT w.level + 1, n.inode, n.type, n.mode, n.mtime, n.size, n.link_target
           FROM walk w
           JOIN segs s ON s.level = w.level
           JOIN vfs_dirents d ON d.parent_inode = w.inode AND d.name = s.name
           JOIN vfs_nodes n ON n.inode = d.child_inode
          WHERE w.type = 'dir'
       )
     SELECT level, inode, type, mode, mtime, size, link_target
       FROM walk
      ORDER BY level`, JSON.stringify(parts), 1);
	const depth = parts.length;
	let target;
	for (const row of rows) {
		if (row.level >= 1 && row.type === "symlink") return { kind: "symlink" };
		if (row.level === depth) target = row;
	}
	return {
		kind: "resolved",
		node: target === void 0 ? null : toResolved(target)
	};
}
function toResolved(node) {
	return {
		inode: node.inode,
		type: node.type,
		mode: node.mode,
		mtime: node.mtime,
		size: node.size,
		linkTarget: node.link_target ?? void 0
	};
}
function resolveParts(db, parts, followFinal, follows) {
	const root = readNode(db, 1);
	if (root === null) return null;
	const pendingParts = [...parts];
	const nodeStack = [root];
	while (pendingParts.length > 0) {
		const name = pendingParts.shift();
		if (name === void 0) continue;
		const current = nodeStack[nodeStack.length - 1];
		if (current.type !== "dir") return null;
		if (name === "" || name === ".") continue;
		if (name === "..") {
			if (nodeStack.length > 1) nodeStack.pop();
			continue;
		}
		const child = db.one("SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?", current.inode, name);
		if (child === void 0) return null;
		const next = readNode(db, child.child_inode);
		if (next === null) return null;
		if (next.type === "symlink" && (pendingParts.length > 0 || followFinal)) {
			follows += 1;
			if (follows > MAX_SYMLINK_FOLLOWS$2) throw createWorkspaceError("ELOOP", "too many symlinks resolving path");
			const target = next.link_target ?? "";
			if (target.startsWith("/")) nodeStack.splice(1);
			pendingParts.unshift(...target.split("/"));
			continue;
		}
		nodeStack.push(next);
	}
	return toResolved(nodeStack[nodeStack.length - 1]);
}
function readNode(db, inode) {
	return db.one("SELECT inode, type, mode, mtime, size, link_target FROM vfs_nodes WHERE inode = ?", inode) ?? null;
}
// src/fs/chmod.ts
function chmod(db, path, mode, now) {
	const { path: canonical } = canonicalizePath(path);
	assertNotReadOnly(db, canonical);
	db.transactionSync(() => {
		const node = resolveInode(db, canonical);
		if (node === null) throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
		const rev = incrementRev(db);
		db.run("UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ? WHERE inode = ?", mode & 4095, now(), rev, node.inode);
	});
}
// src/fs/find.ts
const CHILD_PAGE_SIZE = 128;
function find(db, directory, pattern, options = {}) {
	const start = prepareWalk(db, directory, pattern, options.exclude);
	const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
	if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError("find limit must be a non-negative safe integer");
	const offset = options.offset ?? 0;
	if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("find offset must be a non-negative safe integer");
	if (limit === 0) return [];
	const out = [];
	let seen = 0;
	for (const entry of walk(db, start.inode, start.path, start)) {
		if (seen >= offset) {
			out.push(entry);
			if (out.length >= limit) break;
		}
		seen += 1;
	}
	return out;
}
function* iterateFoundEntries(db, directory, pattern, exclude) {
	const start = prepareWalk(db, directory, pattern, exclude);
	yield* walk(db, start.inode, start.path, start);
}
function prepareWalk(db, directory, pattern, exclude) {
	const { path: canonical } = canonicalizePath(directory);
	const node = resolveInode(db, canonical);
	if (node === null) throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
	if (node.type !== "dir") throw createWorkspaceError("ENOTDIR", `not a directory: ${canonical}`, canonical);
	const regex = pattern ? compileGlob(pattern) : void 0;
	const excludes = (exclude ?? []).filter((glob) => glob !== "").flatMap((glob) => {
		const own = {
			regex: compileGlob(glob),
			directoryOnly: false
		};
		if (!glob.endsWith("/**") || glob.length <= 3) return [own];
		return [own, {
			regex: compileGlob(glob.slice(0, -3)),
			directoryOnly: true
		}];
	});
	return {
		inode: node.inode,
		path: canonical,
		prefix: canonical === "/" ? "/" : `${canonical}/`,
		regex,
		excludes
	};
}
function* walk(db, parentInode, parentPath, start) {
	const { prefix, regex, excludes } = start;
	let afterName = "";
	while (true) {
		const children = readChildren(db, parentInode, afterName);
		if (children.length === 0) return;
		for (const child of children) {
			const childPath = parentPath === "/" ? `/${child.name}` : `${parentPath}/${child.name}`;
			const relativePath = childPath.slice(prefix.length);
			if (excludes.some((excluded) => (!excluded.directoryOnly || child.type === "dir") && excluded.regex.test(relativePath))) continue;
			if (regex === void 0 || regex.test(relativePath)) yield {
				path: childPath,
				type: child.type
			};
			if (child.type === "dir") yield* walk(db, child.child_inode, childPath, start);
		}
		if (children.length < CHILD_PAGE_SIZE) return;
		afterName = children[children.length - 1].name;
	}
}
function readChildren(db, parentInode, afterName) {
	return db.all(`SELECT d.name AS name, d.child_inode AS child_inode, n.type AS type
       FROM vfs_dirents d
       JOIN vfs_nodes n ON n.inode = d.child_inode
      WHERE d.parent_inode = ? AND d.name > ?
      ORDER BY d.name
      LIMIT ?`, parentInode, afterName, CHILD_PAGE_SIZE);
}
function compileGlob(pattern) {
	return new RegExp(`^${globSource(pattern)}$`);
}
function globSource(pattern) {
	let re = "";
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === "{") {
			const alternatives = braceAlternatives(pattern, i);
			if (alternatives !== void 0) {
				re += `(?:${alternatives.parts.map(globSource).join("|")})`;
				i = alternatives.end + 1;
				continue;
			}
		}
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				if (pattern[i + 2] === "/") {
					re += "(?:.*/)?";
					i += 3;
				} else {
					re += ".*";
					i += 2;
				}
			} else {
				re += "[^/]*";
				i += 1;
			}
			continue;
		}
		if (ch === "?") {
			re += "[^/]";
			i += 1;
			continue;
		}
		if (REGEX_METACHARS.has(ch)) re += `\\${ch}`;
		else re += ch;
		i += 1;
	}
	return re;
}
function braceAlternatives(pattern, open) {
	const parts = [];
	let depth = 0;
	let start = open + 1;
	for (let i = open + 1; i < pattern.length; i += 1) {
		const ch = pattern[i];
		if (ch === "{") depth += 1;
		else if (ch === "}") {
			if (depth === 0) {
				parts.push(pattern.slice(start, i));
				return parts.length > 1 ? {
					parts,
					end: i
				} : void 0;
			}
			depth -= 1;
		} else if (ch === "," && depth === 0) {
			parts.push(pattern.slice(start, i));
			start = i + 1;
		}
	}
}
const REGEX_METACHARS = /* @__PURE__ */ new Set([
	".",
	"+",
	"?",
	"^",
	"$",
	"(",
	")",
	"[",
	"]",
	"{",
	"}",
	"|",
	"\\"
]);
// src/fs/writeBuffer.ts
const caches = /* @__PURE__ */ new WeakMap();
function cacheFor(db) {
	let cache = caches.get(db);
	if (cache === void 0) {
		cache = {
			byInode: /* @__PURE__ */ new Map(),
			byPendingPath: /* @__PURE__ */ new Map(),
			byPendingParent: /* @__PURE__ */ new Map(),
			nextPendingInode: -1
		};
		caches.set(db, cache);
	}
	return cache;
}
function getWriteBuffer(db, inode) {
	return caches.get(db)?.byInode.get(inode);
}
function getPendingWriteBufferByPath(db, canonicalPath) {
	return caches.get(db)?.byPendingPath.get(canonicalPath);
}
function pendingParentKey(parentInode, leafName) {
	return `${parentInode}:${leafName}`;
}
function getPendingWriteBufferByParent(db, parentInode, leafName) {
	return caches.get(db)?.byPendingParent.get(pendingParentKey(parentInode, leafName));
}
function hasPendingWriteBuffers(db) {
	return (caches.get(db)?.byPendingParent.size ?? 0) > 0;
}
function listPendingByParent(db, parentInode) {
	return listPendingWriteBuffers(db).filter((entry) => entry.pending?.parentInode === parentInode);
}
function listPendingWriteBuffers(db) {
	const cache = caches.get(db);
	if (cache === void 0) return [];
	return [...cache.byInode.values()].filter((entry) => entry.pending !== void 0);
}
function setWriteBuffer(db, inode, entry) {
	const cache = cacheFor(db);
	cache.byInode.set(inode, entry);
	if (entry.pending !== void 0) {
		cache.byPendingPath.set(entry.pending.canonicalPath, entry);
		cache.byPendingPath.set(entry.pending.resolvedPath, entry);
		cache.byPendingParent.set(pendingParentKey(entry.pending.parentInode, entry.pending.leafName), entry);
	}
}
function deleteWriteBuffer(db, inode) {
	const cache = caches.get(db);
	if (cache === void 0) return;
	const entry = cache.byInode.get(inode);
	if (entry?.pending !== void 0) {
		cache.byPendingPath.delete(entry.pending.canonicalPath);
		cache.byPendingPath.delete(entry.pending.resolvedPath);
		cache.byPendingParent.delete(pendingParentKey(entry.pending.parentInode, entry.pending.leafName));
	}
	cache.byInode.delete(inode);
}
function allocatePendingInode(db) {
	const cache = cacheFor(db);
	const next = cache.nextPendingInode;
	cache.nextPendingInode -= 1;
	return next;
}
function promotePendingToInode(db, pendingInode, realInode) {
	const cache = caches.get(db);
	if (cache === void 0) return;
	const entry = cache.byInode.get(pendingInode);
	if (entry === void 0) return;
	if (entry.pending !== void 0) {
		cache.byPendingPath.delete(entry.pending.canonicalPath);
		cache.byPendingPath.delete(entry.pending.resolvedPath);
		cache.byPendingParent.delete(pendingParentKey(entry.pending.parentInode, entry.pending.leafName));
		entry.pending = void 0;
	}
	cache.byInode.delete(pendingInode);
	cache.byInode.set(realInode, entry);
}
function ensureCapacity(entry, needed) {
	if (entry.buf.byteLength >= needed) return;
	let cap = Math.max(entry.buf.byteLength * 2, 65536);
	while (cap < needed) cap *= 2;
	const next = new Uint8Array(cap);
	next.set(entry.buf.subarray(0, entry.size), 0);
	entry.buf = next;
}
// src/fs/pendingWriteBuffer.ts
function findPendingWriteBuffer(db, path) {
	if (!hasPendingWriteBuffers(db)) return void 0;
	const { parts, path: canonical } = canonicalizePath(path);
	const direct = getPendingWriteBufferByPath(db, canonical);
	if (direct !== void 0 || parts.length === 0) return direct;
	const leafName = parts.at(-1);
	if (leafName === void 0) return void 0;
	const parent = resolveInode(db, parts.length === 1 ? "/" : `/${parts.slice(0, -1).join("/")}`);
	if (parent?.type !== "dir") return void 0;
	return getPendingWriteBufferByParent(db, parent.inode, leafName);
}
// src/sync/blobs.ts
function stageBlob(db, hash, bytes) {
	db.transactionSync(() => {
		db.run("INSERT INTO vfs_blobs (hash, size, last_seen) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET size = excluded.size, last_seen = excluded.last_seen", hash, bytes.byteLength, Date.now());
		db.run("INSERT INTO vfs_blob_bytes (hash, bytes) VALUES (?, ?) ON CONFLICT(hash) DO UPDATE SET bytes = excluded.bytes", hash, bytes);
	});
	clearBlobCache(db);
}
// src/sync/manifests.ts
const MANIFEST_VERSION = 1;
function toHex$4(bytes) {
	let out = "";
	for (let i = 0; i < bytes.byteLength; i++) out += bytes[i].toString(16).padStart(2, "0");
	return out;
}
function sha256$1(bytes) {
	return new Uint8Array(createHash("sha256").update(bytes).digest());
}
function encodeManifest(chunks) {
	const encoded = {
		version: 1,
		chunks: chunks.map((c) => ({
			hash: toHex$4(c.hash),
			size: c.size
		}))
	};
	return new TextEncoder().encode(JSON.stringify(encoded));
}
function computeManifestHash(chunks) {
	return sha256$1(encodeManifest(chunks));
}
function buildManifest(db, chunks) {
	const bytes = encodeManifest(chunks);
	const hash = sha256$1(bytes);
	const size = chunks.reduce((acc, c) => acc + c.size, 0);
	db.run("INSERT INTO vfs_manifests (hash, size, encoded, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(hash) DO UPDATE SET last_seen = excluded.last_seen", hash, size, bytes, Date.now());
	return hash;
}
// src/sync/paths.ts
function pathOf(db, inode) {
	if (inode === 1) return "/";
	const segments = [];
	let current = inode;
	for (let i = 0; i < 1e6; i++) {
		const row = db.one("SELECT parent_inode, name FROM vfs_dirents WHERE child_inode = ?", current);
		if (row === void 0) return null;
		segments.push(row.name);
		if (row.parent_inode === 1) {
			segments.reverse();
			return `/${segments.join("/")}`;
		}
		current = row.parent_inode;
	}
	return null;
}
const PATHS_BATCH_SIZE = 512;
function pathsOfMany(db, inodes) {
	const out = /* @__PURE__ */ new Map();
	if (inodes.length === 0) return out;
	const unique = [];
	const seen = /* @__PURE__ */ new Set();
	for (const inode of inodes) {
		if (seen.has(inode)) continue;
		seen.add(inode);
		if (inode === 1) {
			out.set(1, ["/"]);
			continue;
		}
		unique.push(inode);
	}
	if (unique.length === 0) return out;
	for (let start = 0; start < unique.length; start += PATHS_BATCH_SIZE) collectBatch(db, unique.slice(start, start + PATHS_BATCH_SIZE), out);
	return out;
}
function collectBatch(db, batch, out) {
	const rows = db.all(`WITH RECURSIVE
       targets(inode) AS (
         SELECT value FROM json_each(?)
       ),
       walk(target, link, depth, name, parent_inode) AS (
         SELECT t.inode, d.parent_inode || '/' || d.name, 0, d.name, d.parent_inode
           FROM targets t
           JOIN vfs_dirents d ON d.child_inode = t.inode
         UNION ALL
         SELECT w.target, w.link, w.depth + 1, d.name, d.parent_inode
           FROM walk w
           JOIN vfs_dirents d ON d.child_inode = w.parent_inode
          WHERE w.parent_inode <> ?
       )
     SELECT target, link, depth, name, parent_inode
       FROM walk
      ORDER BY target, link, depth DESC`, JSON.stringify(batch), 1);
	let currentTarget;
	let currentLink;
	let segments = [];
	let reachedRoot = false;
	const flush = () => {
		if (currentTarget === void 0) return;
		if (reachedRoot && segments.length > 0) {
			const path = `/${segments.join("/")}`;
			const existing = out.get(currentTarget);
			if (existing === void 0) out.set(currentTarget, [path]);
			else existing.push(path);
		}
		segments = [];
		reachedRoot = false;
	};
	for (const row of rows) {
		if (row.target !== currentTarget || row.link !== currentLink) {
			flush();
			currentTarget = row.target;
			currentLink = row.link;
		}
		segments.push(row.name);
		if (row.parent_inode === 1) reachedRoot = true;
	}
	flush();
}
// src/fs/chunk.ts
const CHUNK_SIZE = 524288;
// src/storage.ts
const transactionLocals = /* @__PURE__ */ new WeakMap();
/**
* @internal
* State that lives for the current outermost transaction on `db`. The
* first call in a transaction creates the value with `create`; later
* calls, nested transactions included, return the same value. Just
* before the outermost transaction commits, still inside it,
* `beforeCommit` runs with the value, so whatever it writes commits or
* rolls back with the rest.
*
* Three things follow. A rollback of the outermost transaction discards
* the value without calling `beforeCommit`. A nested transaction is a
* savepoint, and rolling one back does not touch the value: whatever was
* recorded inside it stays, so `beforeCommit` has to check the database
* rather than trust it. A `beforeCommit` that throws fails the whole
* transaction, and with it the write that opened it.
*
* Throws outside a transaction.
*/
function transactionLocal(db, key, create, beforeCommit) {
	if (!db.inTransaction) throw new Error("transactionLocal called outside transactionSync");
	let locals = transactionLocals.get(db);
	if (locals === void 0) {
		locals = /* @__PURE__ */ new Map();
		transactionLocals.set(db, locals);
	}
	const existing = locals.get(key);
	if (existing !== void 0) return existing.value;
	const value = create();
	locals.set(key, {
		value,
		beforeCommit
	});
	return value;
}
function runBeforeCommit(db) {
	const locals = transactionLocals.get(db);
	if (locals === void 0) return;
	for (const [key, { value, beforeCommit }] of locals) {
		locals.delete(key);
		beforeCommit(value);
	}
}
var Database = class {
	sql;
	transactionSync;
	#txDepth = 0;
	constructor(storage) {
		this.sql = storage.sql;
		this.transactionSync = (closure) => {
			if (this.#txDepth > 0 && storage.transactionSync === void 0) {
				const sp = `_t${this.#txDepth}`;
				this.sql.exec(`SAVEPOINT ${sp}`);
				this.#txDepth++;
				try {
					const result = closure();
					this.sql.exec(`RELEASE ${sp}`);
					return result;
				} catch (error) {
					this.sql.exec(`ROLLBACK TO ${sp}`);
					this.sql.exec(`RELEASE ${sp}`);
					throw error;
				} finally {
					this.#txDepth--;
				}
			}
			const run = () => {
				const result = closure();
				if (this.#txDepth === 1) runBeforeCommit(this);
				return result;
			};
			this.#txDepth++;
			try {
				if (storage.transactionSync !== void 0) return storage.transactionSync(run);
				if (storage.transaction !== void 0) {
					const result = storage.transaction(run);
					if (result !== void 0 && result !== null && typeof result === "object" && "then" in result) throw new Error("Durable Object storage adapter requires synchronous transactions");
					return result;
				}
				return run();
			} finally {
				this.#txDepth--;
				if (this.#txDepth === 0) transactionLocals.delete(this);
			}
		};
	}
	get inTransaction() {
		return this.#txDepth > 0;
	}
	run(query, ...bindings) {
		this.sql.exec(query, ...bindings);
	}
	all(query, ...bindings) {
		return this.sql.exec(query, ...bindings).toArray().map((row) => normalizeRow(row));
	}
	one(query, ...bindings) {
		return this.all(query, ...bindings)[0];
	}
	scalar(query, ...bindings) {
		const row = this.one(query, ...bindings);
		if (row === void 0) return;
		const [value] = Object.values(row);
		return value;
	}
};
function normalizeRow(row) {
	const out = {};
	for (const key of Object.keys(row)) {
		const value = row[key];
		out[key] = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
	}
	return out;
}
// src/fs/refs.ts
const DEFERRED_RETRIES_PER_WRITE = 16;
const HELD_REAPS_PER_TRANSACTION = 100;
const APPLY_IDLE_LEASE_MS = 3e5;
const BACKGROUND_REAP_BYTES_PER_WRITE = CHUNK_SIZE;
const SWEEP_GRACE_MS = 36e5;
const states = /* @__PURE__ */ new WeakMap();
const TRANSACTION_KEY = {};
function stateFor(db) {
	let state = states.get(db);
	if (state === void 0) {
		state = {
			holding: void 0,
			deferredBlobs: /* @__PURE__ */ new Map(),
			sweepBlobsAfter: 0,
			sweepManifestsAfter: 0,
			sweepManifestsNext: false
		};
		states.set(db, state);
	}
	return state;
}
function transactionRefs(db) {
	return transactionLocal(db, TRANSACTION_KEY, () => ({
		droppedBlobs: /* @__PURE__ */ new Map(),
		droppedManifests: /* @__PURE__ */ new Map()
	}), (refs) => reapDropped(db, refs));
}
function inTransaction(db, fn) {
	return db.inTransaction ? fn() : db.transactionSync(fn);
}
function dropBlob(db, hash, size) {
	transactionRefs(db).droppedBlobs.set(hashKey(hash), {
		hash,
		size
	});
}
function dropManifest(db, hash) {
	if (hash !== null) transactionRefs(db).droppedManifests.set(hashKey(hash), hash);
}
function relinkBlob(db, hash) {
	transactionRefs(db).droppedBlobs.delete(hashKey(hash));
}
function reapDropped(db, refs) {
	const state = stateFor(db);
	const hold = state.holding;
	const unpinned = [];
	for (const [key, dropped] of refs.droppedBlobs) {
		if (hold !== void 0) {
			hold.blobs.set(key, dropped);
			hold.pin.add(dropped.hash);
			continue;
		}
		if (isKeyPinned(db, key)) {
			state.deferredBlobs.set(key, dropped);
			continue;
		}
		unpinned.push(dropped.hash);
	}
	reapBlobs(db, unpinned);
	reapManifests(db, [...refs.droppedManifests.values()]);
	const budget = { bytes: BACKGROUND_REAP_BYTES_PER_WRITE };
	retryDeferred(db, state, DEFERRED_RETRIES_PER_WRITE, budget);
	sweepStep(db, state, budget);
}
function sweepStep(db, state, budget) {
	const cutoff = Date.now() - SWEEP_GRACE_MS;
	const manifests = state.sweepManifestsNext;
	state.sweepManifestsNext = !manifests;
	const rows = manifests ? db.all(`SELECT rowid AS id, hash, size,
                last_seen < ?
                AND NOT EXISTS (SELECT 1 FROM vfs_nodes n WHERE n.manifest_hash = m.hash) AS orphan
           FROM vfs_manifests m
          WHERE rowid > ?
          ORDER BY rowid
          LIMIT ?`, cutoff, state.sweepManifestsAfter, 8) : db.all(`SELECT rowid AS id, hash, size,
                last_seen < ?
                AND NOT EXISTS (SELECT 1 FROM vfs_chunks c WHERE c.hash = b.hash) AS orphan
           FROM vfs_blobs b
          WHERE rowid > ?
          ORDER BY rowid
          LIMIT ?`, cutoff, state.sweepBlobsAfter, 8);
	let after = rows.length < 8 ? 0 : rows[rows.length - 1].id;
	const orphans = [];
	for (const [i, row] of rows.entries()) {
		if (row.orphan !== 1) continue;
		if (manifests) {
			orphans.push(row.hash);
			continue;
		}
		const key = hashKey(row.hash);
		if (isKeyPinned(db, key)) continue;
		if (!spend(budget, row.size)) {
			after = i === 0 ? state.sweepBlobsAfter : rows[i - 1].id;
			break;
		}
		state.deferredBlobs.delete(key);
		orphans.push(row.hash);
	}
	if (manifests) state.sweepManifestsAfter = after;
	else state.sweepBlobsAfter = after;
	if (manifests) reapManifests(db, orphans);
	else reapBlobs(db, orphans);
}
function spend(budget, size) {
	if (size > budget.bytes && budget.bytes < BACKGROUND_REAP_BYTES_PER_WRITE) return false;
	budget.bytes -= size;
	return true;
}
function retryDeferred(db, state, limit, budget) {
	const batch = firstEntries(state.deferredBlobs, limit);
	const reaped = [];
	const stillPinned = [];
	for (const entry of batch) {
		if (isKeyPinned(db, entry[0])) {
			stillPinned.push(entry);
			continue;
		}
		if (!spend(budget, entry[1].size)) break;
		reaped.push(entry);
	}
	reapBlobs(db, reaped.map(([, dropped]) => dropped.hash));
	for (const [key] of reaped) state.deferredBlobs.delete(key);
	for (const [key, dropped] of stillPinned) {
		state.deferredBlobs.delete(key);
		state.deferredBlobs.set(key, dropped);
	}
}
function firstEntries(map, limit) {
	const out = [];
	for (const entry of map) {
		if (out.length >= limit) break;
		out.push(entry);
	}
	return out;
}
const REAP_BATCH = 100;
const REAP_BATCH_SIZES = [
	1,
	8,
	32,
	REAP_BATCH
];
function reapBatches(hashes) {
	const out = [];
	for (let i = 0; i < hashes.length; i += REAP_BATCH) {
		const batch = hashes.slice(i, i + REAP_BATCH);
		const size = REAP_BATCH_SIZES.find((s) => s >= batch.length) ?? REAP_BATCH;
		while (batch.length < size) batch.push(batch[batch.length - 1]);
		out.push(batch);
	}
	return out;
}
function placeholders(count) {
	return Array.from({ length: count }, () => "?").join(", ");
}
function reapBlobs(db, hashes) {
	for (const batch of reapBatches(hashes)) {
		const gone = db.all(`DELETE FROM vfs_blobs
          WHERE hash IN (${placeholders(batch.length)})
            AND NOT EXISTS (SELECT 1 FROM vfs_chunks c WHERE c.hash = vfs_blobs.hash)
          RETURNING hash`, ...batch).map((row) => row.hash);
		for (const bytesBatch of reapBatches(gone)) db.run(`DELETE FROM vfs_blob_bytes WHERE hash IN (${placeholders(bytesBatch.length)})`, ...bytesBatch);
		for (const hash of gone) evictBlob(db, hash);
	}
}
function reapManifests(db, hashes) {
	for (const batch of reapBatches(hashes)) db.run(`DELETE FROM vfs_manifests
        WHERE hash IN (${placeholders(batch.length)})
          AND NOT EXISTS (SELECT 1 FROM vfs_nodes n WHERE n.manifest_hash = vfs_manifests.hash)`, ...batch);
}
function openReapDeferral(db) {
	const state = stateFor(db);
	const held = {
		blobs: /* @__PURE__ */ new Map(),
		pin: pinHashes(db, [], { leaseMs: APPLY_IDLE_LEASE_MS })
	};
	let open = true;
	return {
		hold(step) {
			if (!open) return step();
			held.pin.renew();
			const previous = state.holding;
			state.holding = held;
			try {
				return step();
			} finally {
				state.holding = previous;
			}
		},
		close() {
			if (!open) return;
			open = false;
			held.pin.release();
			reapHeld(db, state, held.blobs);
		}
	};
}
function reapHeld(db, state, blobs) {
	const entries = [...blobs];
	for (let i = 0; i < entries.length; i += HELD_REAPS_PER_TRANSACTION) {
		const batch = entries.slice(i, i + HELD_REAPS_PER_TRANSACTION);
		try {
			inTransaction(db, () => {
				const unpinned = [];
				for (const [key, dropped] of batch) if (isKeyPinned(db, key)) state.deferredBlobs.set(key, dropped);
				else unpinned.push(dropped.hash);
				reapBlobs(db, unpinned);
			});
		} catch {
			for (const [key, dropped] of batch) state.deferredBlobs.set(key, dropped);
		}
	}
}
function linkChunk(db, inode, idx, hash, size) {
	inTransaction(db, () => {
		db.run("INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)", inode, idx, hash, size);
		relinkBlob(db, hash);
	});
}
function replaceChunk(db, inode, idx, hash, size, previous) {
	inTransaction(db, () => {
		db.run("INSERT OR REPLACE INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)", inode, idx, hash, size);
		relinkBlob(db, hash);
		if (previous !== void 0) dropBlob(db, previous.hash, previous.size);
	});
}
function dropChunks(db, inode, fromIdx = 0) {
	return inTransaction(db, () => {
		const rows = db.all("DELETE FROM vfs_chunks WHERE inode = ? AND idx >= ? RETURNING hash, size", inode, fromIdx);
		for (const row of rows) dropBlob(db, row.hash, row.size);
		return rows.map((row) => row.hash);
	});
}
function setNodeManifest(db, inode, manifestHash, fields) {
	inTransaction(db, () => {
		const previous = db.scalar("SELECT manifest_hash FROM vfs_nodes WHERE inode = ?", inode);
		db.run("UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ?, size = ?, manifest_hash = ? WHERE inode = ?", fields.mode, fields.mtime, fields.rev, fields.size, manifestHash, inode);
		dropManifest(db, previous ?? null);
		if (manifestHash !== null) transactionRefs(db).droppedManifests.delete(hashKey(manifestHash));
	});
}
function deleteNode(db, inode) {
	inTransaction(db, () => {
		dropManifest(db, db.one("DELETE FROM vfs_nodes WHERE inode = ? RETURNING manifest_hash", inode)?.manifest_hash ?? null);
	});
}
// src/fs/writeFile.ts
function resolveParent$1(db, parts, canonical, follows) {
	const pendingParts = parts.slice(0, -1);
	const inodeStack = [1];
	const realParts = [];
	const ancestorInodes = /* @__PURE__ */ new Set([1]);
	while (pendingParts.length > 0) {
		const name = pendingParts.shift();
		if (name === void 0 || name === "" || name === ".") continue;
		if (name === "..") {
			if (inodeStack.length > 1) {
				inodeStack.pop();
				realParts.pop();
			}
			continue;
		}
		const parentInode = inodeStack[inodeStack.length - 1];
		const child = db.one("SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?", parentInode, name);
		if (child === void 0) throw createWorkspaceError("ENOENT", `parent directory missing: ${canonical}`, canonical);
		const node = db.one("SELECT inode, type, link_target FROM vfs_nodes WHERE inode = ?", child.child_inode);
		if (node === void 0) throw createWorkspaceError("ENOENT", `dangling dirent: ${canonical}`, canonical);
		if (node.type === "symlink") {
			ancestorInodes.add(node.inode);
			countSymlinkFollow$1(follows, canonical);
			const target = node.link_target ?? "";
			assertNotInReadOnlyMount(db, clampedPathFromParts(symlinkTargetParts(target, realParts)));
			if (target.startsWith("/")) {
				inodeStack.splice(1);
				realParts.splice(0);
			}
			pendingParts.unshift(...target.split("/"));
			continue;
		}
		if (node.type !== "dir") throw createWorkspaceError("ENOTDIR", `parent path segment is not a directory: ${canonical}`, canonical);
		inodeStack.push(node.inode);
		realParts.push(name);
		ancestorInodes.add(node.inode);
	}
	return {
		inode: inodeStack[inodeStack.length - 1],
		canonicalPath: pathFromParts$1(realParts),
		ancestorInodes: [...ancestorInodes]
	};
}
async function materialize(content) {
	if (typeof content === "string") return new TextEncoder().encode(content);
	return content;
}
function sha256(bytes) {
	const hash = createHash("sha256");
	hash.update(bytes);
	return new Uint8Array(hash.digest());
}
const MAX_SYMLINK_FOLLOWS$1 = 40;
function countSymlinkFollow$1(follows, path) {
	follows.count += 1;
	if (follows.count > MAX_SYMLINK_FOLLOWS$1) throw createWorkspaceError("ELOOP", "too many symlinks resolving path", path);
}
function pathFromParts$1(parts) {
	return `/${parts.join("/")}`;
}
function clampedPathFromParts(parts) {
	const clamped = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			clamped.pop();
			continue;
		}
		clamped.push(part);
	}
	return pathFromParts$1(clamped);
}
function childPath(db, parentInode, leafName, path) {
	const parentPath = pathOf(db, parentInode);
	if (parentPath === null) throw createWorkspaceError("ENOENT", `parent directory missing: ${path}`, path);
	return parentPath === "/" ? `/${leafName}` : `${parentPath}/${leafName}`;
}
function pendingTargetPath(entry, fallback) {
	return entry.pending?.resolvedPath ?? fallback;
}
function symlinkTargetParts(target, linkParentParts) {
	return [...target.startsWith("/") ? [] : linkParentParts, ...target.split("/")];
}
function resolveDirectWriteTarget(db, parts, canonical, follows = { count: 0 }) {
	const parent = resolveParent$1(db, parts, canonical, follows);
	const leafName = parts[parts.length - 1];
	const canonicalPath = parent.canonicalPath === "/" ? `/${leafName}` : `${parent.canonicalPath}/${leafName}`;
	assertNotReadOnly(db, canonicalPath);
	const existing = db.one("SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?", parent.inode, leafName);
	return {
		parentInode: parent.inode,
		leafName,
		canonicalPath,
		ancestorInodes: parent.ancestorInodes,
		existingInode: existing?.child_inode
	};
}
function resolveWriteTarget(db, parts, canonical, options) {
	let targetParts = parts;
	let targetCanonical = canonical;
	const follows = { count: 0 };
	assertNotReadOnly(db, canonical);
	while (true) {
		const direct = resolveDirectWriteTarget(db, targetParts, targetCanonical, follows);
		if (direct.existingInode === void 0) return {
			kind: "create",
			parentInode: direct.parentInode,
			leafName: direct.leafName,
			canonicalPath: direct.canonicalPath
		};
		if (options.exclusive) throw createWorkspaceError("EEXIST", `path exists: ${canonical}`, canonical);
		const node = db.one("SELECT type, link_target FROM vfs_nodes WHERE inode = ?", direct.existingInode);
		if (node === void 0) throw createWorkspaceError("ENOENT", `dangling dirent: ${targetCanonical}`, targetCanonical);
		if (node.type === "dir") throw createWorkspaceError("EISDIR", `path is a directory: ${targetCanonical}`, targetCanonical);
		if (node.type !== "symlink") return {
			kind: "existing",
			inode: direct.existingInode,
			canonicalPath: direct.canonicalPath
		};
		countSymlinkFollow$1(follows, canonical);
		const realLinkParts = canonicalizePath(direct.canonicalPath).parts;
		targetParts = symlinkTargetParts(node.link_target ?? "", realLinkParts.slice(0, -1));
		targetCanonical = clampedPathFromParts(targetParts);
		assertNotInReadOnlyMount(db, targetCanonical);
		const finalPart = targetParts.at(-1);
		if (finalPart === void 0 || finalPart === "" || finalPart === "." || finalPart === "..") {
			resolveParent$1(db, [...targetParts, "__write_target__"], targetCanonical, follows);
			throw createWorkspaceError("EISDIR", "path is a directory", targetCanonical);
		}
	}
}
function chunksOf(bytes) {
	const chunks = [];
	for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
		const end = Math.min(offset + CHUNK_SIZE, bytes.byteLength);
		const slice = bytes.subarray(offset, end);
		const hash = sha256(slice);
		chunks.push({
			hash,
			bytes: slice,
			size: slice.byteLength
		});
	}
	return chunks;
}
async function writeFile(db, path, content, options, now) {
	if (content instanceof ReadableStream) {
		await writeFileStreaming(db, path, content, options, now);
		return;
	}
	writeFileSync(db, path, await materialize(content), options, now);
}
async function writeFileStreaming(db, path, source, options, now) {
	const { parts, path: canonical } = canonicalizePath(path);
	if (parts.length === 0) throw createWorkspaceError("EISDIR", "cannot write to the root directory", canonical);
	resolveWriteTarget(db, parts, canonical, options);
	const mode = (options.mode ?? 420) & 4095;
	const mtime = now();
	const chunkRefs = [];
	const staged = pinHashes(db, []);
	const flush = (chunk) => {
		const hash = sha256(chunk);
		staged.add(hash);
		stageBlob(db, hash, chunk);
		chunkRefs.push({
			hash,
			size: chunk.byteLength
		});
	};
	try {
		await stageSource(source, flush);
		linkStagedChunksSync(db, canonical, parts, chunkRefs, {
			...options,
			mode
		}, mtime);
	} finally {
		staged.release();
	}
}
async function stageSource(source, flush) {
	let carry;
	const reader = source.getReader();
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value === void 0 || value.byteLength === 0) continue;
			let input = value;
			if (carry !== void 0) {
				const merged = new Uint8Array(carry.byteLength + input.byteLength);
				merged.set(carry, 0);
				merged.set(input, carry.byteLength);
				input = merged;
				carry = void 0;
			}
			let offset = 0;
			while (input.byteLength - offset >= CHUNK_SIZE) {
				flush(input.slice(offset, offset + CHUNK_SIZE));
				offset += CHUNK_SIZE;
			}
			if (offset < input.byteLength) carry = input.slice(offset);
		}
	} finally {
		reader.releaseLock();
	}
	if (carry !== void 0 && carry.byteLength > 0) flush(carry);
}
function assertChunkWindows(chunkRefs, canonical) {
	for (let idx = 0; idx < chunkRefs.length; idx++) {
		const { size } = chunkRefs[idx];
		const last = idx === chunkRefs.length - 1;
		if (size === 524288 || last && size < 524288) continue;
		throw createWorkspaceError("EINVAL", `chunk ${idx} of ${chunkRefs.length} holds ${size} bytes; only the last chunk may be shorter than ${CHUNK_SIZE}: ${canonical}`, canonical);
	}
}
function linkStagedChunksSync(db, canonical, parts, chunkRefs, options, mtime) {
	assertNotReadOnly(db, canonical);
	assertChunkWindows(chunkRefs, canonical);
	const mode = (options.mode ?? 420) & 4095;
	db.transactionSync(() => {
		assertStagedBytes(db, chunkRefs, canonical);
		const target = resolveWriteTarget(db, parts, canonical, options);
		const inode = target.kind === "existing" ? target.inode : insertFileNode(db, mode, mtime);
		if (target.kind === "existing") dropChunks(db, inode);
		else insertFileDirent(db, target.parentInode, target.leafName, inode, target.canonicalPath);
		for (let idx = 0; idx < chunkRefs.length; idx++) {
			const ref = chunkRefs[idx];
			linkChunk(db, inode, idx, ref.hash, ref.size);
		}
		const manifestHash = buildManifest(db, chunkRefs);
		const rev = incrementRev(db);
		let totalSize = 0;
		for (const ref of chunkRefs) totalSize += ref.size;
		setNodeManifest(db, inode, manifestHash, {
			mode,
			mtime,
			rev,
			size: totalSize
		});
	});
}
function assertStagedBytes(db, chunkRefs, canonical) {
	const checked = /* @__PURE__ */ new Set();
	for (const { hash } of chunkRefs) {
		const key = hashKey(hash);
		if (checked.has(key)) continue;
		checked.add(key);
		if (db.one("SELECT 1 AS present FROM vfs_blob_bytes WHERE hash = ?", hash) !== void 0) continue;
		throw createWorkspaceError("EUNKNOWN_HASH", `chunk ${hexOf(hash)} has no staged bytes; stage it and retry: ${canonical}`, canonical);
	}
}
function hexOf(bytes) {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}
function insertFileDirent(db, parentInode, leafName, childInode, canonicalPath) {
	db.run("INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)", parentInode, leafName, childInode);
	invalidateResolveExact(db, canonicalPath);
}
function insertFileNode(db, mode, mtime) {
	const row = db.one("INSERT INTO vfs_nodes (type, mode, mtime, rev) VALUES ('file', ?, ?, 0) RETURNING inode", mode, mtime);
	if (row === void 0) throw createWorkspaceError("EIO", "failed to allocate inode");
	return row.inode;
}
function upsertChunkBlob(db, chunk) {
	db.run("INSERT INTO vfs_blobs (hash, size, last_seen) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET last_seen = excluded.last_seen", chunk.hash, chunk.size, Date.now());
	db.run("INSERT INTO vfs_blob_bytes (hash, bytes) VALUES (?, ?) ON CONFLICT(hash) DO NOTHING", chunk.hash, chunk.bytes);
}
function replaceChunkRows(db, inode, chunks) {
	dropChunks(db, inode);
	for (let idx = 0; idx < chunks.length; idx++) {
		const chunk = chunks[idx];
		linkChunk(db, inode, idx, chunk.hash, chunk.size);
	}
	return buildManifest(db, chunks);
}
function rangesOverlap(start, end, ranges) {
	for (const range of ranges) if (range.start < end && start < range.end) return true;
	return false;
}
function normalizeRanges(ranges, size) {
	const normalized = ranges.map((range) => ({
		start: Math.max(0, Math.min(size, Math.floor(range.start))),
		end: Math.max(0, Math.min(size, Math.ceil(range.end)))
	})).filter((range) => range.start < range.end).sort((a, b) => a.start - b.start);
	const merged = [];
	for (const range of normalized) {
		const previous = merged.at(-1);
		if (previous === void 0 || previous.end < range.start) merged.push({ ...range });
		else previous.end = Math.max(previous.end, range.end);
	}
	return merged;
}
function existingChunkRefs(db, inode) {
	return db.all("SELECT hash, size FROM vfs_chunks WHERE inode = ? ORDER BY idx", inode);
}
function fileSizeForInode(db, inode) {
	return db.scalar("SELECT size FROM vfs_nodes WHERE inode = ?", inode) ?? 0;
}
function readChunkBytes(db, inode, idx) {
	const chunk = db.one("SELECT hash FROM vfs_chunks WHERE inode = ? AND idx = ?", inode, idx);
	if (chunk === void 0) return /* @__PURE__ */ new Uint8Array();
	const bytes = getBlobBytes(db, chunk.hash);
	if (bytes === void 0) throw createWorkspaceError("EIO", "missing blob bytes");
	return bytes;
}
function resolveFileInode(db, path) {
	const { path: canonical } = canonicalizePath(path);
	const node = resolveInode(db, canonical);
	if (node === null) throw createWorkspaceError("ENOENT", `no such file: ${canonical}`, canonical);
	if (node.type !== "file") throw createWorkspaceError("EISDIR", `path is a directory: ${canonical}`, canonical);
	return {
		inode: node.inode,
		mode: node.mode
	};
}
function resolveWritableFileInode(db, path) {
	const { parts, path: canonical } = canonicalizePath(path);
	if (parts.length === 0) throw createWorkspaceError("EISDIR", "cannot write to the root directory", canonical);
	const target = resolveWriteTarget(db, parts, canonical, {});
	if (target.kind === "create") throw createWorkspaceError("ENOENT", `no such file: ${canonical}`, canonical);
	const mode = db.scalar("SELECT mode FROM vfs_nodes WHERE inode = ?", target.inode);
	if (mode === void 0) throw createWorkspaceError("ENOENT", `no such file: ${canonical}`, canonical);
	return {
		inode: target.inode,
		mode,
		canonicalPath: target.canonicalPath
	};
}
function directTargetForPath(db, path) {
	const { parts, path: canonical } = canonicalizePath(path);
	if (parts.length === 0) throw createWorkspaceError("EISDIR", "cannot write to the root directory", canonical);
	assertNotReadOnly(db, canonical);
	return resolveDirectWriteTarget(db, parts, canonical);
}
function applyChunkedInodeUpdate(db, inode, size, mode, mtime, isTouched, buildChunkBytes) {
	const oldChunks = existingChunkRefs(db, inode);
	const chunkCount = Math.ceil(size / CHUNK_SIZE);
	const oldChunkCount = oldChunks.length;
	for (let idx = 0; idx < chunkCount; idx++) {
		const start = idx * CHUNK_SIZE;
		const end = Math.min(start + CHUNK_SIZE, size);
		const intendedSize = end - start;
		const old = oldChunks[idx];
		const touched = isTouched(idx, start, end);
		if (old?.size === intendedSize && !touched) continue;
		const existingBytes = old !== void 0 ? readChunkBytes(db, inode, idx) : /* @__PURE__ */ new Uint8Array();
		const chunkBytes = buildChunkBytes(idx, start, end, existingBytes);
		if (chunkBytes.byteLength !== intendedSize) throw createWorkspaceError("EIO", "chunk builder returned wrong size");
		const chunk = {
			hash: sha256(chunkBytes),
			bytes: chunkBytes,
			size: chunkBytes.byteLength
		};
		upsertChunkBlob(db, chunk);
		replaceChunk(db, inode, idx, chunk.hash, chunk.size, old);
	}
	if (oldChunkCount > chunkCount) dropChunks(db, inode, chunkCount);
	setNodeManifest(db, inode, null, {
		mode,
		mtime,
		rev: incrementRev(db),
		size
	});
}
function createFileSync(db, path, options, now) {
	const { path: canonical } = canonicalizePath(path);
	const target = directTargetForPath(db, path);
	const mode = (options.mode ?? 420) & 4095;
	const mtime = now();
	db.transactionSync(() => {
		if (target.existingInode !== void 0) throw createWorkspaceError("EEXIST", `path exists: ${canonical}`, canonical);
		const rev = incrementRev(db);
		const row = db.one("INSERT INTO vfs_nodes (type, mode, mtime, rev, manifest_hash) VALUES ('file', ?, ?, ?, NULL) RETURNING inode", mode, mtime, rev);
		if (row === void 0) throw createWorkspaceError("EIO", "failed to allocate inode");
		insertFileDirent(db, target.parentInode, target.leafName, row.inode, target.canonicalPath);
	});
}
function openWriteBufferSync(db, path) {
	const { path: canonical } = canonicalizePath(path);
	const pending = findPendingWriteBuffer(db, canonical);
	if (pending !== void 0) {
		pending.openCount += 1;
		return;
	}
	const { inode, mode } = resolveFileInode(db, path);
	const existing = getWriteBuffer(db, inode);
	if (existing !== void 0) {
		existing.openCount += 1;
		return;
	}
	setWriteBuffer(db, inode, {
		buf: /* @__PURE__ */ new Uint8Array(0),
		size: 0,
		dirty: false,
		openCount: 1,
		mode
	});
}
function openWriteBufferForCreateSync(db, path, options, now) {
	const { path: canonical } = canonicalizePath(path);
	if (getPendingWriteBufferByPath(db, canonical) !== void 0) throw createWorkspaceError("EEXIST", `path exists: ${canonical}`, canonical);
	const target = directTargetForPath(db, path);
	if (target.existingInode !== void 0 || getPendingWriteBufferByPath(db, target.canonicalPath) !== void 0) throw createWorkspaceError("EEXIST", `path exists: ${canonical}`, canonical);
	const mode = (options.mode ?? 420) & 4095;
	const mtime = now();
	const pendingInode = allocatePendingInode(db);
	setWriteBuffer(db, pendingInode, {
		buf: /* @__PURE__ */ new Uint8Array(0),
		size: 0,
		dirty: true,
		openCount: 1,
		mode,
		pending: {
			parentInode: target.parentInode,
			leafName: target.leafName,
			canonicalPath: canonical,
			resolvedPath: target.canonicalPath,
			ancestorInodes: target.ancestorInodes,
			pendingInode,
			mtime
		}
	});
}
function releaseWriteBufferSync(db, path, now) {
	const { path: canonical } = canonicalizePath(path);
	const pending = findPendingWriteBuffer(db, canonical);
	if (pending !== void 0) {
		releasePendingBuffer(db, pending, now);
		return;
	}
	const node = resolveFileInode(db, path);
	const entry = getWriteBuffer(db, node.inode);
	if (entry === void 0) return;
	entry.openCount -= 1;
	if (entry.openCount > 0) return;
	if (!entry.dirty) {
		deleteWriteBuffer(db, node.inode);
		return;
	}
	const mtime = now();
	const mode = entry.mode & 4095;
	const buffered = entry.buf.subarray(0, entry.size);
	try {
		if (entry.dirtyPath === void 0 || entry.dirtyTargetPath === void 0) throw createWorkspaceError("EIO", `buffer has no writable path: ${canonical}`, canonical);
		assertNotReadOnly(db, entry.dirtyPath);
		assertNotReadOnly(db, entry.dirtyTargetPath);
		db.transactionSync(() => {
			if (entry.size === 0) {
				dropChunks(db, node.inode);
				const rev = incrementRev(db);
				setNodeManifest(db, node.inode, null, {
					mode,
					mtime,
					rev,
					size: 0
				});
				return;
			}
			applyChunkedInodeUpdate(db, node.inode, entry.size, mode, mtime, (_idx, start, end) => start < entry.size && end > 0, (_idx, start, end) => buffered.subarray(start, Math.min(end, entry.size)));
		});
	} catch (error) {
		deleteWriteBuffer(db, node.inode);
		throw error;
	}
	deleteWriteBuffer(db, node.inode);
}
function commitPendingBuffer(db, entry, now) {
	if (entry.pending === void 0) throw createWorkspaceError("EIO", "commitPendingBuffer called on non-pending entry");
	const { parentInode, leafName, canonicalPath, pendingInode } = entry.pending;
	const mtime = now();
	const mode = entry.mode & 4095;
	const buffered = entry.buf.subarray(0, entry.size);
	let realInode = 0;
	try {
		db.transactionSync(() => {
			assertNotReadOnly(db, canonicalPath);
			const targetPath = childPath(db, parentInode, leafName, canonicalPath);
			assertNotReadOnly(db, targetPath);
			if (db.one("SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?", parentInode, leafName) !== void 0) throw createWorkspaceError("EEXIST", `path exists at commit time: ${canonicalPath}`, canonicalPath);
			const rev = incrementRev(db);
			const row = db.one("INSERT INTO vfs_nodes (type, mode, mtime, rev, size, manifest_hash) VALUES ('file', ?, ?, ?, ?, NULL) RETURNING inode", mode, mtime, rev, entry.size);
			if (row === void 0) throw createWorkspaceError("EIO", "failed to allocate inode");
			insertFileDirent(db, parentInode, leafName, row.inode, targetPath);
			if (entry.size > 0) {
				const inode = row.inode;
				const chunkCount = Math.ceil(entry.size / CHUNK_SIZE);
				for (let idx = 0; idx < chunkCount; idx++) {
					const start = idx * CHUNK_SIZE;
					const end = Math.min(start + CHUNK_SIZE, entry.size);
					const chunkBytes = buffered.subarray(start, end);
					const chunk = {
						hash: sha256(chunkBytes),
						bytes: chunkBytes,
						size: chunkBytes.byteLength
					};
					upsertChunkBlob(db, chunk);
					linkChunk(db, inode, idx, chunk.hash, chunk.size);
				}
			}
			realInode = row.inode;
		});
	} catch (error) {
		deleteWriteBuffer(db, pendingInode);
		throw error;
	}
	promotePendingToInode(db, pendingInode, realInode);
	entry.dirty = false;
	return realInode;
}
/**
* @internal
* Bridges a pending-create write buffer into the SQL world ahead of a
* dirent-mutating provider operation (link, rename, unlink). Leaves
* the open count untouched so a still-open handle keeps writing into
* the now-promoted buffer. Returns true when a pending buffer was
* committed. External callers should never invoke this directly.
*/
function flushPendingByPath(db, path, now) {
	const { path: canonical } = canonicalizePath(path);
	const entry = findPendingWriteBuffer(db, canonical);
	if (entry?.pending === void 0) return false;
	commitPendingBuffer(db, entry, now);
	return true;
}
/** @internal Commits pending files reached through a node before its dirent changes. */
function flushPendingUnderNode(db, path, now) {
	const node = resolveInode(db, path, { followSymlinks: false });
	if (node === null) return;
	for (const entry of listPendingWriteBuffers(db)) if (entry.pending?.ancestorInodes.includes(node.inode)) commitPendingBuffer(db, entry, now);
}
function releasePendingBuffer(db, entry, now) {
	if (entry.pending === void 0) return;
	entry.openCount -= 1;
	if (entry.openCount > 0) return;
	deleteWriteBuffer(db, commitPendingBuffer(db, entry, now));
}
function hydrateBufferIfNeeded(db, inode, entry) {
	if (entry.dirty) return;
	const existingSize = fileSizeForInode(db, inode);
	if (existingSize === 0) {
		entry.dirty = true;
		return;
	}
	ensureCapacity(entry, existingSize);
	let copied = 0;
	for (let idx = 0; copied < existingSize; idx++) {
		const chunk = readChunkBytes(db, inode, idx);
		if (chunk.byteLength === 0) break;
		entry.buf.set(chunk, copied);
		copied += chunk.byteLength;
	}
	entry.size = existingSize;
	entry.dirty = true;
}
function writeRangeSync(db, path, bytes, offset, options, now) {
	const { path: canonical } = canonicalizePath(path);
	assertNotReadOnly(db, canonical);
	if (!Number.isInteger(offset) || offset < 0) throw createWorkspaceError("EINVAL", `invalid write offset: ${offset}`, canonical);
	if (bytes.byteLength === 0) return 0;
	const mtime = now();
	const pending = findPendingWriteBuffer(db, canonical);
	if (pending !== void 0) {
		assertNotReadOnly(db, pendingTargetPath(pending, canonical));
		const writeEnd = offset + bytes.byteLength;
		ensureCapacity(pending, writeEnd);
		if (offset > pending.size) pending.buf.fill(0, pending.size, offset);
		pending.buf.set(bytes, offset);
		if (writeEnd > pending.size) pending.size = writeEnd;
		pending.mode = (options.mode ?? pending.mode) & 4095;
		pending.dirty = true;
		return bytes.byteLength;
	}
	const { inode, mode: existingMode, canonicalPath: targetPath } = resolveWritableFileInode(db, path);
	const mode = (options.mode ?? existingMode) & 4095;
	const buffered = getWriteBuffer(db, inode);
	if (buffered !== void 0) {
		hydrateBufferIfNeeded(db, inode, buffered);
		const writeEnd = offset + bytes.byteLength;
		ensureCapacity(buffered, writeEnd);
		if (offset > buffered.size) buffered.buf.fill(0, buffered.size, offset);
		buffered.buf.set(bytes, offset);
		if (writeEnd > buffered.size) buffered.size = writeEnd;
		buffered.mode = mode;
		buffered.dirty = true;
		buffered.dirtyPath = canonical;
		buffered.dirtyTargetPath = targetPath;
		return bytes.byteLength;
	}
	db.transactionSync(() => {
		const oldSize = fileSizeForInode(db, inode);
		const writeEnd = offset + bytes.byteLength;
		applyChunkedInodeUpdate(db, inode, Math.max(oldSize, writeEnd), mode, mtime, (_idx, start, end) => offset < end && start < writeEnd, (_idx, start, end, existing) => {
			const chunkBytes = new Uint8Array(end - start);
			chunkBytes.set(existing.subarray(0, Math.min(existing.byteLength, chunkBytes.byteLength)));
			if (offset < end && start < writeEnd) {
				const copyStart = Math.max(start, offset);
				const copyEnd = Math.min(end, writeEnd);
				chunkBytes.set(bytes.subarray(copyStart - offset, copyEnd - offset), copyStart - start);
			}
			return chunkBytes;
		});
	});
	return bytes.byteLength;
}
function truncateFileSync(db, path, size, now) {
	const { path: canonical } = canonicalizePath(path);
	assertNotReadOnly(db, canonical);
	if (!Number.isInteger(size) || size < 0) throw createWorkspaceError("EINVAL", `invalid truncate size: ${size}`, canonical);
	const mtime = now();
	const pending = findPendingWriteBuffer(db, canonical);
	if (pending !== void 0) {
		assertNotReadOnly(db, pendingTargetPath(pending, canonical));
		if (size > pending.size) {
			ensureCapacity(pending, size);
			pending.buf.fill(0, pending.size, size);
		}
		pending.size = size;
		pending.dirty = true;
		return;
	}
	const { inode, mode, canonicalPath: targetPath } = resolveWritableFileInode(db, path);
	const buffered = getWriteBuffer(db, inode);
	if (buffered !== void 0) {
		hydrateBufferIfNeeded(db, inode, buffered);
		if (size > buffered.size) {
			ensureCapacity(buffered, size);
			buffered.buf.fill(0, buffered.size, size);
		}
		buffered.size = size;
		buffered.dirty = true;
		buffered.dirtyPath = canonical;
		buffered.dirtyTargetPath = targetPath;
		return;
	}
	db.transactionSync(() => {
		if (fileSizeForInode(db, inode) === size) return;
		if (size === 0) {
			dropChunks(db, inode);
			const rev = incrementRev(db);
			setNodeManifest(db, inode, null, {
				mode,
				mtime,
				rev,
				size: 0
			});
			return;
		}
		applyChunkedInodeUpdate(db, inode, size, mode, mtime, () => false, (_idx, start, end, existing) => {
			const chunkBytes = new Uint8Array(end - start);
			chunkBytes.set(existing.subarray(0, Math.min(existing.byteLength, chunkBytes.byteLength)));
			return chunkBytes;
		});
	});
}
function writeFileSync(db, path, bytes, options, now) {
	const { parts, path: canonical } = canonicalizePath(path);
	if (parts.length === 0) throw createWorkspaceError("EISDIR", "cannot write to the root directory", canonical);
	assertNotReadOnly(db, canonical);
	const mode = (options.mode ?? 420) & 4095;
	const mtime = now();
	db.transactionSync(() => {
		const target = resolveWriteTarget(db, parts, canonical, options);
		const inode = target.kind === "existing" ? target.inode : insertFileNode(db, mode, mtime);
		if (target.kind === "existing") dropChunks(db, inode);
		else insertFileDirent(db, target.parentInode, target.leafName, inode, target.canonicalPath);
		const rev = incrementRev(db);
		const chunks = chunksOf(bytes);
		for (let idx = 0; idx < chunks.length; idx++) {
			const chunk = chunks[idx];
			upsertChunkBlob(db, chunk);
			linkChunk(db, inode, idx, chunk.hash, chunk.size);
		}
		setNodeManifest(db, inode, buildManifest(db, chunks), {
			mode,
			mtime,
			rev,
			size: bytes.byteLength
		});
	});
}
function writeFileRangesSync(db, path, bytes, dirtyRanges, options, now) {
	const { parts, path: canonical } = canonicalizePath(path);
	if (parts.length === 0) throw createWorkspaceError("EISDIR", "cannot write to the root directory", canonical);
	assertNotReadOnly(db, canonical);
	const mode = (options.mode ?? 420) & 4095;
	const ranges = normalizeRanges(dirtyRanges, bytes.byteLength);
	const mtime = now();
	db.transactionSync(() => {
		const target = resolveWriteTarget(db, parts, canonical, options);
		const inode = target.kind === "existing" ? target.inode : insertFileNode(db, mode, mtime);
		let oldChunks = [];
		if (target.kind === "existing") oldChunks = existingChunkRefs(db, inode);
		else insertFileDirent(db, target.parentInode, target.leafName, inode, target.canonicalPath);
		const rev = incrementRev(db);
		const nextChunks = [];
		const chunkCount = Math.ceil(bytes.byteLength / CHUNK_SIZE);
		for (let idx = 0; idx < chunkCount; idx++) {
			const start = idx * CHUNK_SIZE;
			const end = Math.min(start + CHUNK_SIZE, bytes.byteLength);
			const size = end - start;
			const oldChunk = oldChunks[idx];
			if (oldChunk?.size === size && !rangesOverlap(start, end, ranges)) {
				nextChunks.push(oldChunk);
				continue;
			}
			const chunk = {
				hash: sha256(bytes.subarray(start, end)),
				bytes: bytes.subarray(start, end),
				size
			};
			upsertChunkBlob(db, chunk);
			nextChunks.push({
				hash: chunk.hash,
				size: chunk.size
			});
		}
		setNodeManifest(db, inode, replaceChunkRows(db, inode, nextChunks), {
			mode,
			mtime,
			rev,
			size: bytes.byteLength
		});
	});
}
// src/fs/readFile.ts
async function readFile(db, path, optionsOrEncoding) {
	const options = typeof optionsOrEncoding === "object" ? optionsOrEncoding : void 0;
	const wantString = optionsOrEncoding === "utf8" || options?.encoding === "utf8";
	const byteOffset = options?.byteOffset ?? 0;
	const byteLength = options?.byteLength;
	validateReadWindow(path, byteOffset, byteLength);
	const { path: canonical } = canonicalizePath(path);
	const pending = findPendingWriteBuffer(db, canonical);
	if (pending !== void 0) return snapshotResult(pending.buf, pending.size, byteOffset, byteLength, wantString);
	const node = resolveInode(db, path);
	if (node === null) throw createWorkspaceError("ENOENT", `no such file: ${path}`, path);
	if (node.type !== "file") throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
	const buffered = getWriteBuffer(db, node.inode);
	if (buffered?.dirty) return snapshotResult(buffered.buf, buffered.size, byteOffset, byteLength, wantString);
	const { start, end, length } = readWindow(node.size, byteOffset, byteLength);
	const firstIdx = length === 0 ? 0 : Math.floor(start / CHUNK_SIZE);
	const lastIdx = length === 0 ? -1 : Math.floor((end - 1) / CHUNK_SIZE);
	const chunks = length === 0 ? [] : db.all(`SELECT idx, hash, size
             FROM vfs_chunks
            WHERE inode = ? AND idx BETWEEN ? AND ?
            ORDER BY idx`, node.inode, firstIdx, lastIdx);
	assertDenseRange(chunks, firstIdx, lastIdx, path);
	if (wantString) {
		const out = new Uint8Array(length);
		let written = 0;
		for (const chunk of chunks) {
			const bytes = rangedChunkBytes(db, path, chunk, start, end);
			out.set(bytes, written);
			written += bytes.byteLength;
		}
		return new TextDecoder().decode(out);
	}
	let index = 0;
	const pin = pinHashes(db, chunks.map((chunk) => chunk.hash), { leaseMs: STREAM_IDLE_LEASE_MS });
	return new ReadableStream({
		pull(controller) {
			if (index >= chunks.length) {
				pin.release();
				controller.close();
				return;
			}
			pin.renew();
			const chunk = chunks[index++];
			try {
				controller.enqueue(rangedChunkBytes(db, path, chunk, start, end));
			} catch (error) {
				pin.release();
				throw error;
			}
		},
		cancel() {
			pin.release();
		}
	});
}
function validateReadWindow(path, byteOffset, byteLength) {
	if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) throw createWorkspaceError("EINVAL", `invalid read offset: ${byteOffset}`, path);
	if (byteLength !== void 0 && (!Number.isSafeInteger(byteLength) || byteLength < 0)) throw createWorkspaceError("EINVAL", `invalid read length: ${byteLength}`, path);
}
function readWindow(size, byteOffset, byteLength) {
	const start = Math.min(byteOffset, size);
	const available = size - start;
	const length = byteLength === void 0 ? available : Math.min(available, byteLength);
	return {
		start,
		end: start + length,
		length
	};
}
function snapshotResult(source, size, byteOffset, byteLength, wantString) {
	const { start, end } = readWindow(size, byteOffset, byteLength);
	const snapshot = source.slice(start, end);
	if (wantString) return new TextDecoder().decode(snapshot);
	return new ReadableStream({ start(controller) {
		if (snapshot.byteLength > 0) controller.enqueue(snapshot);
		controller.close();
	} });
}
function assertDenseRange(chunks, firstIdx, lastIdx, path) {
	for (let idx = firstIdx; idx <= lastIdx; idx += 1) if (chunks[idx - firstIdx]?.idx !== idx) throw createWorkspaceError("EIO", `missing chunk data for ${path}`, path);
}
function rangedChunkBytes(db, path, chunk, start, end) {
	const bytes = getBlobBytes(db, chunk.hash);
	if (bytes === void 0) throw createWorkspaceError("EIO", `missing blob bytes for ${path}`, path);
	const chunkStart = chunk.idx * CHUNK_SIZE;
	const from = Math.max(0, start - chunkStart);
	const to = Math.min(bytes.byteLength, end - chunkStart);
	return bytes.subarray(from, to);
}
function readRangeSync(db, path, offset, length) {
	if (!Number.isInteger(offset) || offset < 0) throw createWorkspaceError("EINVAL", `invalid read offset: ${offset}`, path);
	if (!Number.isInteger(length) || length < 0) throw createWorkspaceError("EINVAL", `invalid read length: ${length}`, path);
	const { path: canonical } = canonicalizePath(path);
	const pending = findPendingWriteBuffer(db, canonical);
	if (pending !== void 0) {
		if (length === 0) return /* @__PURE__ */ new Uint8Array();
		if (offset >= pending.size) return /* @__PURE__ */ new Uint8Array();
		const end = Math.min(offset + length, pending.size);
		return pending.buf.slice(offset, end);
	}
	const node = resolveInode(db, path);
	if (node === null) throw createWorkspaceError("ENOENT", `no such file: ${path}`, path);
	if (node.type !== "file") throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
	if (length === 0) return /* @__PURE__ */ new Uint8Array();
	const buffered = getWriteBuffer(db, node.inode);
	if (buffered?.dirty) {
		if (offset >= buffered.size) return /* @__PURE__ */ new Uint8Array();
		const end = Math.min(offset + length, buffered.size);
		return buffered.buf.slice(offset, end);
	}
	const totalSize = node.size;
	if (offset >= totalSize) return /* @__PURE__ */ new Uint8Array();
	const end = Math.min(offset + length, totalSize);
	const firstIdx = Math.floor(offset / CHUNK_SIZE);
	const lastIdx = Math.floor((end - 1) / CHUNK_SIZE);
	const chunks = db.all("SELECT idx, hash FROM vfs_chunks WHERE inode = ? AND idx BETWEEN ? AND ? ORDER BY idx", node.inode, firstIdx, lastIdx);
	assertDenseRange(chunks, firstIdx, lastIdx, path);
	const out = new Uint8Array(end - offset);
	let written = 0;
	for (const { idx, hash } of chunks) {
		const start = idx * CHUNK_SIZE;
		const bytes = getBlobBytes(db, hash);
		if (bytes === void 0) throw createWorkspaceError("EIO", `missing blob bytes for ${path}`, path);
		const srcStart = Math.max(0, offset - start);
		const srcEnd = Math.min(bytes.byteLength, end - start);
		if (srcEnd <= srcStart) continue;
		out.set(bytes.subarray(srcStart, srcEnd), written);
		written += srcEnd - srcStart;
	}
	if (written !== out.byteLength) throw createWorkspaceError("EIO", `incomplete chunk data for ${path}`, path);
	return out;
}
// src/fs/grep.ts
async function grep(db, pattern, path, options = {}) {
	const { path: canonical } = canonicalizePath(path);
	const node = resolveInode(db, canonical);
	if (node === null) throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
	const settings = normalizeOptions(options);
	if (settings.limit === 0) return [];
	const matcher = compileMatcher(pattern, {
		regex: settings.regex,
		ignoreCase: settings.ignoreCase
	});
	const matches = [];
	const state = {
		seen: 0,
		accepted: 0
	};
	const filePaths = node.type === "file" ? [canonical] : filesUnder(db, canonical, options.include, options.exclude);
	for (const filePath of filePaths) if (await scanFile(db, filePath, matcher, settings.context, settings.offset, settings.limit, state, matches)) break;
	return matches;
}
function normalizeOptions(options) {
	const context = options.context ?? 0;
	if (!Number.isSafeInteger(context) || context < 0) throw new TypeError("grep context must be a non-negative safe integer");
	const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
	if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError("grep limit must be a non-negative safe integer");
	const offset = options.offset ?? 0;
	if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("grep offset must be a non-negative safe integer");
	return {
		ignoreCase: options.ignoreCase ?? false,
		regex: options.regex ?? false,
		context,
		limit,
		offset
	};
}
function* filesUnder(db, directory, include, exclude) {
	for (const entry of iterateFoundEntries(db, directory, include, exclude)) if (entry.type === "file") yield entry.path;
}
function compileMatcher(pattern, options) {
	const source = options.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	try {
		return new RegExp(source, options.ignoreCase ? "i" : "");
	} catch (error) {
		throw new TypeError(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
	}
}
async function scanFile(db, path, matcher, context, offset, limit, state, out) {
	const before = [];
	const pending = [];
	for await (const current of readLines(db, path)) {
		const isMatch = matcher.test(current.text);
		const contextLine = {
			...current,
			isMatch
		};
		for (const item of pending) {
			item.match.context?.push({ ...contextLine });
			item.remaining -= 1;
		}
		flushReady(pending, out);
		if (state.accepted >= limit && pending.length === 0) return true;
		if (isMatch) {
			const matchIndex = state.seen;
			state.seen += 1;
			if (matchIndex >= offset && state.accepted < limit) {
				const match = {
					path,
					line: current.line,
					text: current.text
				};
				if (context > 0) {
					match.context = [...before.map((line) => ({ ...line })), { ...contextLine }];
					pending.push({
						match,
						remaining: context
					});
				} else out.push(match);
				state.accepted += 1;
			}
		}
		before.push(contextLine);
		if (before.length > context) before.shift();
		if (state.accepted >= limit && pending.length === 0) return true;
	}
	for (const item of pending) out.push(item.match);
	return state.accepted >= limit;
}
function flushReady(pending, out) {
	while (pending[0]?.remaining === 0) {
		const item = pending.shift();
		if (item !== void 0) out.push(item.match);
	}
}
async function* readLines(db, path) {
	const reader = (await readFile(db, path)).getReader();
	const decoder = new TextDecoder("utf-8", { fatal: false });
	let tail = "";
	let line = 1;
	let completed = false;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) {
				completed = true;
				break;
			}
			if (value === void 0) continue;
			tail += decoder.decode(value, { stream: true });
			let newline = tail.indexOf("\n");
			while (newline !== -1) {
				yield {
					line,
					text: tail.slice(0, newline)
				};
				line += 1;
				tail = tail.slice(newline + 1);
				newline = tail.indexOf("\n");
			}
		}
		tail += decoder.decode();
		if (tail.length > 0) yield {
			line,
			text: tail
		};
	} finally {
		if (!completed) await reader.cancel();
		reader.releaseLock();
	}
}
// src/fs/ls.ts
const LS_QUERY = `
  WITH RECURSIVE walk(inode, path, type) AS (
    SELECT inode, ?, type FROM vfs_nodes WHERE inode = ?
    UNION ALL
    SELECT n.inode, w.path || '/' || d.name, n.type
      FROM walk w
      JOIN vfs_dirents d ON d.parent_inode = w.inode
      JOIN vfs_nodes n ON n.inode = d.child_inode
  )
  SELECT path FROM walk
   WHERE type = 'file'
   ORDER BY path
`;
function resolvePrefixInode(db, parts) {
	let inode = 1;
	for (const name of parts) {
		const child = db.one("SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?", inode, name);
		if (child === void 0) return null;
		inode = child.child_inode;
	}
	return inode;
}
function ls(db, prefix) {
	const { parts, path: canonical } = canonicalizePath(prefix);
	const inode = resolvePrefixInode(db, parts);
	if (inode === null) return [];
	const seedPath = canonical === "/" ? "" : canonical;
	return db.all(LS_QUERY, seedPath, inode).map((row) => row.path);
}
// src/fs/mkdir.ts
const MAX_SYMLINK_FOLLOWS = 40;
function lookupChild(db, parentInode, name) {
	const row = db.one("SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?", parentInode, name);
	if (row === void 0) return;
	const node = db.one("SELECT inode, type, link_target FROM vfs_nodes WHERE inode = ?", row.child_inode);
	if (node === void 0) return;
	return {
		inode: node.inode,
		type: node.type,
		linkTarget: node.link_target
	};
}
function createDir(db, parentInode, name, mode, mtime, rev) {
	const row = db.one("INSERT INTO vfs_nodes (type, mode, mtime, rev) VALUES ('dir', ?, ?, ?) RETURNING inode", mode, mtime, rev);
	if (row === void 0) throw createWorkspaceError("EIO", "failed to allocate inode");
	const inode = row.inode;
	db.run("INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)", parentInode, name, inode);
	return inode;
}
function countSymlinkFollow(follows, path) {
	follows.count += 1;
	if (follows.count > MAX_SYMLINK_FOLLOWS) throw createWorkspaceError("ELOOP", "too many symlinks resolving path", path);
}
function pathFromParts(parts) {
	return `/${parts.join("/")}`;
}
function resolveMkdirParent(db, parts, canonical, recursive, mtime, rev) {
	const pending = parts.slice(0, -1).map((name) => ({
		name,
		fromLink: false
	}));
	const inodeStack = [1];
	const realParts = [];
	const follows = { count: 0 };
	while (pending.length > 0) {
		const segment = pending.shift();
		if (segment === void 0) continue;
		const { name, fromLink } = segment;
		if (name === "" || name === ".") continue;
		if (name === "..") {
			if (inodeStack.length > 1) {
				inodeStack.pop();
				realParts.pop();
			}
			continue;
		}
		const parentInode = inodeStack[inodeStack.length - 1];
		const existing = lookupChild(db, parentInode, name);
		if (existing === void 0) {
			if (!recursive || fromLink) throw createWorkspaceError("ENOENT", `parent directory missing: ${canonical}`, canonical);
			const created = createDir(db, parentInode, name, 493, mtime, rev);
			inodeStack.push(created);
			realParts.push(name);
			invalidateResolveExact(db, pathFromParts(realParts));
			continue;
		}
		if (existing.type === "symlink") {
			countSymlinkFollow(follows, canonical);
			const target = existing.linkTarget ?? "";
			if (target.startsWith("/")) {
				inodeStack.splice(1);
				realParts.splice(0);
			}
			pending.unshift(...target.split("/").map((part) => ({
				name: part,
				fromLink: true
			})));
			continue;
		}
		if (existing.type !== "dir") throw createWorkspaceError("ENOTDIR", `parent path segment is not a directory: ${canonical}`, canonical);
		inodeStack.push(existing.inode);
		realParts.push(name);
	}
	return {
		inode: inodeStack[inodeStack.length - 1],
		realPath: realParts.length === 0 ? "/" : pathFromParts(realParts)
	};
}
function mkdir(db, path, options, now) {
	mkdirWithGuard(db, path, options, now, assertNotReadOnly);
}
function mkdirForSyncParents(db, path, options, now) {
	mkdirWithGuard(db, path, options, now, assertNotInReadOnlyMount);
}
function mkdirWithGuard(db, path, options, now, guard) {
	const { parts, path: canonical } = canonicalizePath(path);
	const recursive = options.recursive === true;
	const mode = (options.mode ?? 493) & 4095;
	if (parts.length === 0) throw createWorkspaceError("EEXIST", `path exists: ${canonical}`, canonical);
	guard(db, canonical);
	db.transactionSync(() => {
		const rev = incrementRev(db);
		const mtime = now();
		const parent = resolveMkdirParent(db, parts, canonical, recursive, mtime, rev);
		const leafName = parts[parts.length - 1];
		const realPath = parent.realPath === "/" ? `/${leafName}` : `${parent.realPath}/${leafName}`;
		if (realPath !== canonical) guard(db, realPath);
		const existing = lookupChild(db, parent.inode, leafName);
		if (existing !== void 0) {
			if (recursive && existing.type === "dir") return;
			throw createWorkspaceError("EEXIST", `path exists: ${canonical}`, canonical);
		}
		createDir(db, parent.inode, leafName, mode, mtime, rev);
		invalidateResolveExact(db, realPath);
		if (realPath !== canonical) invalidateResolveExact(db, canonical);
	});
}
// src/fs/readdir.ts
function readdir(db, path, options = {}) {
	const { path: canonical } = canonicalizePath(path);
	const node = resolveInode(db, canonical);
	if (node === null) throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
	if (node.type !== "dir") throw createWorkspaceError("ENOTDIR", `not a directory: ${canonical}`, canonical);
	const limit = options.limit;
	if (limit !== void 0 && (!Number.isSafeInteger(limit) || limit < 0)) throw new TypeError("readdir limit must be a non-negative safe integer");
	const offset = options.offset ?? 0;
	if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("readdir offset must be a non-negative safe integer");
	if (limit === 0) return [];
	let pending = listPendingByParent(db, node.inode).filter((entry) => entry.pending !== void 0).map((entry) => ({
		name: entry.pending?.leafName ?? "",
		parentPath: canonical,
		size: entry.size,
		mtime: entry.pending?.mtime ?? 0,
		isFile: true,
		isDirectory: false,
		isSymbolicLink: false
	}));
	if (pending.length > 0 && (limit !== void 0 || offset > 0)) pending = pending.filter((entry) => !committedNameExists(db, node.inode, entry.name));
	const queryOffset = pending.length === 0 ? offset : Math.max(0, offset - pending.length);
	const queryLimit = pending.length === 0 ? limit : limit === void 0 ? void 0 : Math.min(Number.MAX_SAFE_INTEGER, limit + pending.length * 2);
	const entries = readRows(db, node.inode, queryLimit, queryOffset).map((row) => toResult(db, canonical, row));
	if (pending.length === 0) return entries;
	const seen = new Set(entries.map((entry) => entry.name));
	for (const entry of pending) if (!seen.has(entry.name)) entries.push(entry);
	entries.sort(compareByName);
	const localOffset = offset - queryOffset;
	return entries.slice(localOffset, limit === void 0 ? void 0 : localOffset + limit);
}
function committedNameExists(db, parentInode, name) {
	return db.one("SELECT 1 AS present FROM vfs_dirents WHERE parent_inode = ? AND name = ? LIMIT 1", parentInode, name) !== void 0;
}
function readRows(db, parentInode, limit, offset) {
	const pagination = limit !== void 0 ? "LIMIT ? OFFSET ?" : offset > 0 ? "LIMIT -1 OFFSET ?" : "";
	const params = limit !== void 0 ? [
		parentInode,
		limit,
		offset
	] : offset > 0 ? [parentInode, offset] : [parentInode];
	return db.all(`SELECT n.inode AS inode,
            d.name AS name,
            n.type AS type,
            n.size AS size,
            n.mtime AS mtime,
            n.link_target AS link_target
       FROM vfs_dirents d
       JOIN vfs_nodes n ON n.inode = d.child_inode
      WHERE d.parent_inode = ?
      ORDER BY d.name
      ${pagination}`, ...params);
}
function toResult(db, parentPath, row) {
	const isFile = row.type === "file";
	const isSymbolicLink = row.type === "symlink";
	const buffered = isFile ? getWriteBuffer(db, row.inode) : void 0;
	const size = isFile ? buffered?.dirty ? buffered.size : row.size : isSymbolicLink ? (row.link_target ?? "").length : 0;
	return {
		name: row.name,
		parentPath,
		size,
		mtime: row.mtime,
		isFile,
		isDirectory: row.type === "dir",
		isSymbolicLink
	};
}
const filenameEncoder = new TextEncoder();
function compareByName(a, b) {
	const left = filenameEncoder.encode(a.name);
	const right = filenameEncoder.encode(b.name);
	const length = Math.min(left.byteLength, right.byteLength);
	for (let index = 0; index < length; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
	return left.byteLength - right.byteLength;
}
/**
* List a directory with each entry's type, permission bits and inode in one
* query. `readdir` leaves the inode out and costs a write-buffer lookup per
* file for its size; a caller that needs an `lstat` per entry for the type
* would otherwise resolve and stat every child.
*
* A pending-create buffer shadows a committed entry of the same name, as it
* does for `lstat`.
*/
function readdirEntries(db, path) {
	const { path: canonical } = canonicalizePath(path);
	const node = resolveInode(db, canonical);
	if (node === null) throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
	if (node.type !== "dir") throw createWorkspaceError("ENOTDIR", `not a directory: ${canonical}`, canonical);
	const rows = db.all(`SELECT n.inode AS inode,
            d.name AS name,
            n.type AS type,
            n.mode AS mode
       FROM vfs_dirents d
       JOIN vfs_nodes n ON n.inode = d.child_inode
      WHERE d.parent_inode = ?
      ORDER BY d.name`, node.inode);
	const entries = /* @__PURE__ */ new Map();
	for (const row of rows) entries.set(row.name, {
		name: row.name,
		type: row.type,
		mode: row.mode & 4095,
		inode: row.inode
	});
	for (const entry of listPendingByParent(db, node.inode)) {
		const name = entry.pending?.leafName;
		if (name === void 0) continue;
		entries.set(name, {
			name,
			type: "file",
			mode: entry.mode & 4095,
			inode: 0
		});
	}
	return [...entries.values()];
}
// src/fs/readlink.ts
function readlink(db, path) {
	const node = resolveInode(db, path, { followSymlinks: false });
	if (node === null) throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
	if (node.type !== "symlink" || node.linkTarget === void 0) throw createWorkspaceError("EINVAL", `not a symlink: ${path}`, path);
	return node.linkTarget;
}
// src/sync/changes.ts
function recordDelete(db, rev, path, prior) {
	db.run("INSERT INTO vfs_changes (rev, path, op, prior) VALUES (?, ?, 'delete', ?)", rev, path, prior ?? null);
}
function materialiseChange(db, path) {
	const canonical = canonicalizePath(path).path;
	const live = resolveInode(db, canonical, { followSymlinks: false });
	if (live !== null) {
		const rev = db.one("SELECT rev FROM vfs_nodes WHERE inode = ?", live.inode)?.rev ?? 0;
		if (live.type === "dir") return {
			kind: "dir",
			rev,
			path: canonical,
			mode: live.mode,
			mtime: live.mtime
		};
		if (live.type === "symlink") return {
			kind: "symlink",
			rev,
			path: canonical,
			target: live.linkTarget ?? "",
			mode: live.mode,
			mtime: live.mtime
		};
		const chunks = db.all("SELECT hash, size FROM vfs_chunks WHERE inode = ? ORDER BY idx", live.inode);
		let size = 0;
		for (const c of chunks) size += c.size;
		return {
			kind: "file",
			rev,
			path: canonical,
			mode: live.mode,
			mtime: live.mtime,
			size,
			chunks
		};
	}
	const tomb = db.one("SELECT rev, op, prior FROM vfs_changes WHERE path = ? ORDER BY id DESC LIMIT 1", canonical);
	if (tomb?.op === "delete") return tomb.prior === null ? {
		kind: "delete",
		rev: tomb.rev,
		path: canonical
	} : {
		kind: "delete",
		rev: tomb.rev,
		path: canonical,
		prior: tomb.prior
	};
	return null;
}
// src/sync/fingerprint.ts
function toHex$3(bytes) {
	let out = "";
	for (let i = 0; i < bytes.byteLength; i++) out += bytes[i].toString(16).padStart(2, "0");
	return out;
}
function fingerprintVersion(version) {
	const mode = version.mode & 4095;
	const parts = version.type === "file" ? [
		"file",
		mode,
		toHex$3(version.manifest)
	] : version.type === "symlink" ? [
		"symlink",
		mode,
		version.target
	] : ["dir", mode];
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
function versionFingerprint(db, inode) {
	const node = db.one("SELECT type, mode, manifest_hash, link_target FROM vfs_nodes WHERE inode = ?", inode);
	if (node === void 0) return void 0;
	if (node.type === "dir") return fingerprintVersion({
		type: "dir",
		mode: node.mode
	});
	if (node.type === "symlink") return fingerprintVersion({
		type: "symlink",
		mode: node.mode,
		target: node.link_target ?? ""
	});
	const manifest = node.manifest_hash ?? computeManifestHash(db.all("SELECT hash, size FROM vfs_chunks WHERE inode = ? ORDER BY idx", inode));
	return fingerprintVersion({
		type: "file",
		mode: node.mode,
		manifest
	});
}
// src/fs/unlink.ts
function unlinkDirent(db, parentInode, name, childInode, type) {
	db.run("DELETE FROM vfs_dirents WHERE parent_inode = ? AND name = ?", parentInode, name);
	if ((db.scalar("SELECT COUNT(*) FROM vfs_dirents WHERE child_inode = ?", childInode) ?? 0) > 0) return false;
	if (type === "file") dropChunks(db, childInode);
	deleteNode(db, childInode);
	return true;
}
// src/fs/rename.ts
function rename(db, oldPath, newPath) {
	const { path: oldCanonical } = canonicalizePath(oldPath);
	const { parts: newParts, path: newCanonical } = canonicalizePath(newPath);
	if (oldCanonical === "/") throw createWorkspaceError("EINVAL", "cannot rename root", oldCanonical);
	if (newParts.length === 0) throw createWorkspaceError("EINVAL", "cannot rename onto root", newCanonical);
	assertNotReadOnly(db, oldCanonical);
	assertNotReadOnly(db, newCanonical);
	db.transactionSync(() => {
		const source = resolveInode(db, oldCanonical, { followSymlinks: false });
		if (source === null) throw createWorkspaceError("ENOENT", `no such path: ${oldCanonical}`, oldCanonical);
		const { parts: oldParts } = canonicalizePath(oldCanonical);
		const oldName = oldParts[oldParts.length - 1];
		const oldParent = resolveInode(db, oldParts.length === 1 ? "/" : `/${oldParts.slice(0, -1).join("/")}`);
		if (oldParent?.type !== "dir") throw createWorkspaceError("ENOENT", `no such path: ${oldCanonical}`, oldCanonical);
		const oldParentReal = pathOf(db, oldParent.inode);
		if (oldParentReal === null) throw createWorkspaceError("ENOENT", `no such path: ${oldCanonical}`, oldCanonical);
		const oldRealPath = oldParentReal === "/" ? `/${oldName}` : `${oldParentReal}/${oldName}`;
		assertNotReadOnly(db, oldRealPath);
		if (oldCanonical === newCanonical) return;
		const newName = newParts[newParts.length - 1];
		const newParent = resolveInode(db, newParts.length === 1 ? "/" : `/${newParts.slice(0, -1).join("/")}`);
		if (newParent?.type !== "dir") throw createWorkspaceError("ENOENT", `parent directory missing: ${newCanonical}`, newCanonical);
		const newParentReal = pathOf(db, newParent.inode);
		if (newParentReal === null) throw createWorkspaceError("ENOENT", `parent directory missing: ${newCanonical}`, newCanonical);
		const newRealPath = newParentReal === "/" ? `/${newName}` : `${newParentReal}/${newName}`;
		assertNotReadOnly(db, newRealPath);
		if (oldParent.inode === newParent.inode && oldName === newName) return;
		const existing = db.one(`SELECT d.child_inode AS child_inode, n.type AS type
         FROM vfs_dirents d
         JOIN vfs_nodes n ON n.inode = d.child_inode
        WHERE d.parent_inode = ? AND d.name = ?`, newParent.inode, newName);
		if (source.type === "dir" && renamedSubtreeContains(db, source.inode, oldRealPath, newParent.inode)) throw createWorkspaceError("EINVAL", `cannot rename a directory into itself: ${oldRealPath}`, newCanonical);
		if (existing !== void 0) {
			assertCompatibleOverwrite(source.type, existing.type, newCanonical);
			if (existing.type === "dir") {
				if ((db.scalar("SELECT COUNT(*) FROM vfs_dirents WHERE parent_inode = ?", existing.child_inode) ?? 0) > 0) throw createWorkspaceError("ENOTEMPTY", `not empty: ${newCanonical}`, newCanonical);
			}
			unlinkDirent(db, newParent.inode, newName, existing.child_inode, existing.type);
		}
		db.run("DELETE FROM vfs_dirents WHERE parent_inode = ? AND name = ?", oldParent.inode, oldName);
		db.run("INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)", newParent.inode, newName, source.inode);
		const rev = incrementRev(db);
		if (source.type === "dir") stampRenamedSubtree(db, source.inode, oldRealPath, rev);
		else {
			db.run("UPDATE vfs_nodes SET rev = ? WHERE inode = ?", rev, source.inode);
			recordDelete(db, rev, oldRealPath, versionFingerprint(db, source.inode));
		}
		if (source.type === "dir") {
			invalidateResolveSubtree(db, oldRealPath);
			invalidateResolveSubtree(db, newRealPath);
		} else {
			invalidateResolveExact(db, oldRealPath);
			invalidateResolveExact(db, newRealPath);
		}
	});
}
function assertCompatibleOverwrite(sourceType, existingType, path) {
	if (sourceType === "dir" && existingType === "dir") return;
	if (existingType === "dir") throw createWorkspaceError("EISDIR", `cannot overwrite directory: ${path}`, path);
	if (sourceType === "dir") throw createWorkspaceError("ENOTDIR", `cannot overwrite non-directory: ${path}`, path);
}
const SUBTREE_CTE = `WITH RECURSIVE subtree(inode, type, path) AS (
  SELECT ?, 'dir', ?
  UNION ALL
  SELECT n.inode, n.type,
         CASE WHEN s.path = '/' THEN '/' || d.name ELSE s.path || '/' || d.name END
    FROM subtree s
    JOIN vfs_dirents d ON d.parent_inode = s.inode
    JOIN vfs_nodes n ON n.inode = d.child_inode
   WHERE s.type = 'dir'
)`;
function renamedSubtreeContains(db, rootInode, rootPath, targetInode) {
	return db.one(`${SUBTREE_CTE} SELECT 1 AS hit FROM subtree WHERE inode = ? LIMIT 1`, rootInode, rootPath, targetInode) !== void 0;
}
function stampRenamedSubtree(db, rootInode, rootPath, rev) {
	db.run(`${SUBTREE_CTE} UPDATE vfs_nodes SET rev = ? WHERE inode IN (SELECT inode FROM subtree)`, rootInode, rootPath, rev);
	db.run(`${SUBTREE_CTE} INSERT INTO vfs_changes (rev, path, op) SELECT ?, path, 'delete' FROM subtree ORDER BY path`, rootInode, rootPath, rev);
}
// src/fs/rm.ts
function* walkPostOrder(db, rootInode, rootPath, rootParentInode, rootName) {
	const stack = [{
		inode: rootInode,
		path: rootPath,
		type: "dir",
		parentInode: rootParentInode,
		name: rootName,
		expanded: false
	}];
	while (stack.length > 0) {
		const top = stack[stack.length - 1];
		if (top.type !== "dir" || top.expanded) {
			stack.pop();
			yield {
				path: top.path,
				inode: top.inode,
				type: top.type,
				parentInode: top.parentInode,
				name: top.name
			};
			continue;
		}
		top.expanded = true;
		const children = db.all(`SELECT d.name AS name, d.child_inode AS child_inode, n.type AS type
         FROM vfs_dirents d
         JOIN vfs_nodes n ON n.inode = d.child_inode
        WHERE d.parent_inode = ?
        ORDER BY d.name`, top.inode);
		for (const child of children) {
			const childPath = top.path === "/" ? `/${child.name}` : `${top.path}/${child.name}`;
			stack.push({
				inode: child.child_inode,
				path: childPath,
				type: child.type,
				parentInode: top.inode,
				name: child.name,
				expanded: false
			});
		}
	}
}
function rm(db, path, options) {
	const { parts, path: canonical } = canonicalizePath(path);
	if (parts.length === 0) throw createWorkspaceError("EPERM", `cannot remove the root directory`, canonical);
	assertNotReadOnly(db, canonical);
	const force = options.force === true;
	const recursive = options.recursive === true;
	db.transactionSync(() => {
		const node = resolveInode(db, canonical, { followSymlinks: false });
		if (node === null) {
			if (force) return;
			throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
		}
		if (node.type === "dir" && !recursive) {
			if ((db.scalar("SELECT COUNT(*) FROM vfs_dirents WHERE parent_inode = ?", node.inode) ?? 0) > 0) throw createWorkspaceError("ENOTEMPTY", `directory not empty: ${canonical}`, canonical);
		}
		const name = parts[parts.length - 1];
		const parent = resolveInode(db, parts.length === 1 ? "/" : `/${parts.slice(0, -1).join("/")}`);
		if (parent?.type !== "dir") throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
		const parentReal = pathOf(db, parent.inode);
		if (parentReal === null) throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
		const realPath = parentReal === "/" ? `/${name}` : `${parentReal}/${name}`;
		assertNotReadOnly(db, realPath);
		const rev = incrementRev(db);
		if (node.type !== "dir" || !recursive) {
			const prior = versionFingerprint(db, node.inode);
			unlinkDirent(db, parent.inode, name, node.inode, node.type);
			recordDelete(db, rev, realPath, prior);
			invalidateResolveExact(db, realPath);
			return;
		}
		for (const entry of walkPostOrder(db, node.inode, realPath, parent.inode, name)) {
			const prior = versionFingerprint(db, entry.inode);
			unlinkDirent(db, entry.parentInode, entry.name, entry.inode, entry.type);
			recordDelete(db, rev, entry.path, prior);
		}
		invalidateResolveSubtree(db, realPath);
	});
}
// src/fs/stat.ts
function stat(db, path) {
	return statShared(db, path, true);
}
function lstat(db, path) {
	return statShared(db, path, false);
}
function statShared(db, path, followFinal) {
	const { name, path: canonical } = canonicalizePath(path);
	const pending = findPendingWriteBuffer(db, canonical);
	if (pending?.pending !== void 0) return {
		name,
		inode: 0,
		mode: pending.mode & 4095,
		mtime: pending.pending.mtime,
		size: pending.size,
		isFile: true,
		isDirectory: false,
		isSymbolicLink: false
	};
	const node = resolveInode(db, path, { followSymlinks: followFinal });
	if (node === null) throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
	const isDirectory = node.type === "dir";
	const isFile = node.type === "file";
	const isSymbolicLink = node.type === "symlink";
	let size = 0;
	if (isFile) {
		const buffered = getWriteBuffer(db, node.inode);
		size = buffered?.dirty ? buffered.size : node.size;
	} else if (isSymbolicLink) size = (node.linkTarget ?? "").length;
	return {
		name,
		inode: node.inode,
		mode: node.mode,
		mtime: node.mtime,
		size,
		isFile,
		isDirectory,
		isSymbolicLink
	};
}
// src/fs/symlink.ts
function symlink(db, target, path, now) {
	const { parts, path: canonical } = canonicalizePath(path);
	if (parts.length === 0) throw createWorkspaceError("EEXIST", "cannot symlink onto root", canonical);
	assertNotReadOnly(db, canonical);
	db.transactionSync(() => {
		let parentInode = 1;
		for (let i = 0; i < parts.length - 1; i++) {
			const child = db.one("SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?", parentInode, parts[i]);
			if (child === void 0) throw createWorkspaceError("ENOENT", `parent directory missing: ${canonical}`, canonical);
			const next = db.one("SELECT inode, type FROM vfs_nodes WHERE inode = ?", child.child_inode);
			if (next?.type !== "dir") throw createWorkspaceError("ENOTDIR", `parent path segment is not a directory: ${canonical}`, canonical);
			parentInode = next.inode;
		}
		const leafName = parts[parts.length - 1];
		if (db.one("SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?", parentInode, leafName) !== void 0) throw createWorkspaceError("EEXIST", `path exists: ${canonical}`, canonical);
		const rev = incrementRev(db);
		const mtime = now();
		const row = db.one("INSERT INTO vfs_nodes (type, mode, mtime, rev, link_target) VALUES ('symlink', ?, ?, ?, ?) RETURNING inode", 511, mtime, rev, target);
		if (row === void 0) throw createWorkspaceError("EIO", "failed to allocate inode");
		const inode = row.inode;
		db.run("INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)", parentInode, leafName, inode);
		invalidateResolveSubtree(db, canonical);
	});
}
// src/fs/filesystem.ts
var WorkspaceFilesystem = class {
	db;
	now;
	constructor(db, options = {}) {
		this.db = db;
		this.now = options.now ?? Date.now;
	}
	readFile(path, optionsOrEncoding) {
		return readFile(this.db, path, optionsOrEncoding);
	}
	async stat(path) {
		return stat(this.db, path);
	}
	async lstat(path) {
		return lstat(this.db, path);
	}
	async readlink(path) {
		return readlink(this.db, path);
	}
	async readdir(path, options = {}) {
		return readdir(this.db, path, options);
	}
	async find(directory, pattern, options = {}) {
		return find(this.db, directory, pattern, options);
	}
	async ls(prefix) {
		return ls(this.db, prefix);
	}
	grep(pattern, path, options = {}) {
		return grep(this.db, pattern, path, options);
	}
	writeFile(path, content, options = {}) {
		return writeFile(this.db, path, content, options, this.now);
	}
	async mkdir(path, options = {}) {
		mkdir(this.db, path, options, this.now);
	}
	async rm(path, options = {}) {
		rm(this.db, path, options);
	}
	async rename(oldPath, newPath) {
		rename(this.db, oldPath, newPath);
	}
	async chmod(path, mode) {
		chmod(this.db, path, mode, this.now);
	}
	async symlink(target, path) {
		symlink(this.db, target, path, this.now);
	}
};
// src/fs/link.ts
function resolveParent(db, parts, canonical) {
	let parentInode = 1;
	for (let i = 0; i < parts.length - 1; i++) {
		const child = db.one("SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?", parentInode, parts[i]);
		if (child === void 0) throw createWorkspaceError("ENOENT", `parent directory missing: ${canonical}`, canonical);
		const next = db.one("SELECT inode, type FROM vfs_nodes WHERE inode = ?", child.child_inode);
		if (next === void 0) throw createWorkspaceError("ENOENT", `dangling dirent: ${canonical}`, canonical);
		if (next.type !== "dir") throw createWorkspaceError("ENOTDIR", `parent path segment is not a directory: ${canonical}`, canonical);
		parentInode = next.inode;
	}
	return parentInode;
}
function link(db, existingPath, newPath) {
	const { parts, path: canonicalNew } = canonicalizePath(newPath);
	if (parts.length === 0) throw createWorkspaceError("EEXIST", "cannot link onto root", canonicalNew);
	assertNotReadOnly(db, canonicalNew);
	db.transactionSync(() => {
		const source = resolveInode(db, existingPath);
		if (source === null) throw createWorkspaceError("ENOENT", `no such file: ${existingPath}`, existingPath);
		if (source.type !== "file") throw createWorkspaceError("EPERM", `cannot hardlink non-file: ${existingPath}`, existingPath);
		const parentInode = resolveParent(db, parts, canonicalNew);
		const leafName = parts[parts.length - 1];
		if (db.one("SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?", parentInode, leafName) !== void 0) throw createWorkspaceError("EEXIST", `path exists: ${canonicalNew}`, canonicalNew);
		db.run("INSERT INTO vfs_dirents (parent_inode, name, child_inode) VALUES (?, ?, ?)", parentInode, leafName, source.inode);
		const rev = incrementRev(db);
		db.run("UPDATE vfs_nodes SET rev = ? WHERE inode = ?", rev, source.inode);
		invalidateResolveExact(db, canonicalNew);
	});
}
// src/sync/ignore.ts
const DEFAULT_IGNORE = [];
function isIgnored(path, patterns) {
	if (patterns.length === 0) return false;
	const segments = path.split("/").filter((s) => s.length > 0);
	for (const segment of segments) for (const p of patterns) if (segment === p) return true;
	return false;
}
// src/sync/watermarks.ts
const DEFAULT_BACKEND_ID = "default";
function readWatermark(db, key, backend = DEFAULT_BACKEND_ID) {
	return db.scalar("SELECT v FROM _vfs_watermark WHERE k = ? AND backend = ?", key, backend) ?? 0;
}
function readFetchRev(db, backend = DEFAULT_BACKEND_ID) {
	return db.scalar("SELECT v FROM _vfs_watermark WHERE k = ? AND backend = ?", "fetchRev", backend) ?? 0;
}
function writeWatermarkValue(db, key, value, backend = DEFAULT_BACKEND_ID) {
	db.run("INSERT INTO _vfs_watermark (k, backend, v) VALUES (?, ?, ?) ON CONFLICT(k, backend) DO UPDATE SET v = excluded.v", key, backend, value);
}
function writeFetchCursorPath(db, path, backend = DEFAULT_BACKEND_ID) {
	db.run("INSERT INTO _vfs_fetch_cursor (k, backend, path) VALUES (?, ?, ?) ON CONFLICT(k, backend) DO UPDATE SET path = excluded.path", "fetch", backend, path);
}
function writeWatermark(db, key, value, backend = DEFAULT_BACKEND_ID) {
	writeWatermarkValue(db, key, value, backend);
}
function readFetchCursor(db, backend = DEFAULT_BACKEND_ID) {
	const rev = readFetchRev(db, backend);
	if (rev === 0) return {
		rev: 0,
		path: null
	};
	return {
		rev,
		path: db.scalar("SELECT path FROM _vfs_fetch_cursor WHERE k = ? AND backend = ?", "fetch", backend) ?? null
	};
}
function readPushCursor(db, backend = DEFAULT_BACKEND_ID) {
	const row = db.one("SELECT rev, path FROM _vfs_push_cursor WHERE k = ? AND backend = ?", "push", backend);
	const watermark = readWatermark(db, "pushRev", backend);
	if (row === void 0 || watermark > row.rev) return {
		rev: watermark,
		path: null
	};
	return {
		rev: row.rev,
		path: row.path
	};
}
function writePushCursor(db, cursor, backend = DEFAULT_BACKEND_ID) {
	db.transactionSync(() => {
		db.run("INSERT INTO _vfs_push_cursor (k, backend, rev, path) VALUES (?, ?, ?, ?) ON CONFLICT(k, backend) DO UPDATE SET rev = excluded.rev, path = excluded.path", "push", backend, cursor.rev, cursor.path);
		writeWatermarkValue(db, "pushRev", cursor.rev, backend);
	});
}
function writeFetchCursor(db, cursor, backend = DEFAULT_BACKEND_ID) {
	db.transactionSync(() => {
		writeWatermarkValue(db, "fetchRev", cursor.rev, backend);
		writeFetchCursorPath(db, cursor.path, backend);
	});
}
function compareChangeCursors(a, b) {
	if (a.rev !== b.rev) return a.rev - b.rev;
	if (a.path === b.path) return 0;
	if (a.path === null) return 1;
	if (b.path === null) return -1;
	return a.path < b.path ? -1 : 1;
}
function currentRev(db) {
	return db.scalar("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;
}
function pushWindowIsEmpty(db, backend = DEFAULT_BACKEND_ID) {
	const pushed = readPushCursor(db, backend);
	if (compareChangeCursors(pushed, {
		rev: currentRev(db),
		path: null
	}) >= 0) return true;
	if (pushed.path !== null) return false;
	return db.one("SELECT 1 AS hit FROM vfs_nodes WHERE rev > ? LIMIT 1", pushed.rev) === void 0 && db.one("SELECT 1 AS hit FROM vfs_changes WHERE rev > ? LIMIT 1", pushed.rev) === void 0;
}
// src/sync/coalesce.ts
async function* coalesceChanges(db, after, options = {}) {
	const ignore = options.ignore ?? [];
	const cursor = typeof after === "number" ? {
		rev: after,
		path: null
	} : after;
	const through = options.through;
	const candidates = /* @__PURE__ */ new Map();
	const lowerRev = cursor.path === null ? cursor.rev : cursor.rev - 1;
	const touched = through === void 0 ? db.all("SELECT inode, rev FROM vfs_nodes WHERE rev > ? ORDER BY rev", lowerRev) : db.all("SELECT inode, rev FROM vfs_nodes WHERE rev > ? AND rev <= ? ORDER BY rev", lowerRev, through.rev);
	const pathsByInode = pathsOfMany(db, touched.map((row) => row.inode));
	for (const { inode, rev } of touched) for (const path of pathsByInode.get(inode) ?? []) {
		if (!inCursorWindow({
			rev,
			path
		}, cursor, through)) continue;
		if (isIgnored(path, ignore)) continue;
		const prior = candidates.get(path);
		if (prior === void 0 || rev > prior.rev) candidates.set(path, {
			path,
			rev
		});
	}
	const tombs = through === void 0 ? db.all("SELECT path, MAX(rev) AS rev FROM vfs_changes WHERE rev > ? AND op = 'delete' GROUP BY path", lowerRev) : db.all("SELECT path, MAX(rev) AS rev FROM vfs_changes WHERE rev > ? AND rev <= ? AND op = 'delete' GROUP BY path", lowerRev, through.rev);
	for (const { path, rev } of tombs) {
		if (!inCursorWindow({
			rev,
			path
		}, cursor, through)) continue;
		if (isIgnored(path, ignore)) continue;
		const prior = candidates.get(path);
		if (prior === void 0 || rev > prior.rev) candidates.set(path, {
			path,
			rev
		});
	}
	const ordered = Array.from(candidates.values()).sort((a, b) => {
		if (a.rev !== b.rev) return a.rev - b.rev;
		return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
	});
	for (const { path } of ordered) {
		const entry = materialiseChange(db, path);
		if (entry !== null && inCursorWindow(entry, cursor, through)) yield entry;
	}
}
function inCursorWindow(entry, after, through) {
	return compareChangeCursors(entry, after) > 0 && (through === void 0 || compareChangeCursors(entry, through) <= 0);
}
// src/fs/watch.ts
function createWatcher(db, path, options, defaultInterval) {
	const { path: canonical } = canonicalizePath(path);
	const prefix = canonical === "/" ? "/" : `${canonical}/`;
	const recursive = options.recursive === true;
	const interval = options.interval ?? defaultInterval;
	const emitter = new EventEmitter();
	let cursor = currentRev(db);
	let closed = false;
	const tick = async () => {
		if (closed) return;
		try {
			const seen = /* @__PURE__ */ new Set();
			for await (const entry of coalesceChanges(db, cursor)) {
				if (!isInScope(entry.path, canonical, prefix, recursive)) continue;
				if (seen.has(entry.path)) continue;
				seen.add(entry.path);
				const filename = relativeName(entry.path, canonical);
				const eventType = entry.kind === "delete" ? "rename" : "change";
				emitter.emit("change", eventType, filename);
			}
			cursor = currentRev(db);
		} catch (error) {
			emitter.emit("error", error);
		}
	};
	const handle = setInterval(() => void tick(), interval);
	handle.unref?.();
	emitter.close = () => {
		if (closed) return;
		closed = true;
		clearInterval(handle);
		emitter.emit("close");
	};
	if (options.signal !== void 0) {
		if (options.signal.aborted) emitter.close();
		else options.signal.addEventListener("abort", () => emitter.close(), { once: true });
	}
	return emitter;
}
function isInScope(entryPath, watchedPath, prefix, recursive) {
	if (entryPath === watchedPath) return true;
	if (!entryPath.startsWith(prefix)) return false;
	if (recursive) return true;
	return !entryPath.slice(prefix.length).includes("/");
}
function relativeName(entryPath, watchedPath) {
	if (entryPath === watchedPath) return "";
	const prefix = watchedPath === "/" ? "/" : `${watchedPath}/`;
	return entryPath.startsWith(prefix) ? entryPath.slice(prefix.length) : entryPath;
}
function createWatchAsyncIterable(watcher) {
	const pending = [];
	const waiters = [];
	let done = false;
	watcher.on("change", (eventType, filename) => {
		const event = {
			eventType,
			filename
		};
		const next = waiters.shift();
		if (next) next({
			value: event,
			done: false
		});
		else pending.push(event);
	});
	watcher.on("close", () => {
		done = true;
		while (waiters.length > 0) {
			const next = waiters.shift();
			if (next) next({
				value: void 0,
				done: true
			});
		}
	});
	return {
		[Symbol.asyncIterator]() {
			return this;
		},
		next() {
			const buffered = pending.shift();
			if (buffered) return Promise.resolve({
				value: buffered,
				done: false
			});
			if (done) return Promise.resolve({
				value: void 0,
				done: true
			});
			return new Promise((resolve) => waiters.push(resolve));
		},
		async return() {
			watcher.close();
			return {
				value: void 0,
				done: true
			};
		}
	};
}
// src/provider.ts
var SQLiteWorkspaceProvider = class {
	db;
	now;
	readonly = false;
	supportsSymlinks = true;
	supportsWatch = true;
	#fds = /* @__PURE__ */ new Map();
	#nextFd = 3;
	watchIntervalMs;
	constructor(db, options = {}) {
		this.db = db;
		this.now = options.now ?? Date.now;
		this.watchIntervalMs = options.watchIntervalMs ?? 100;
	}
	open(path, flags, mode) {
		return Promise.resolve(this.openSync(path, flags, mode));
	}
	openSync(path, flags = "r", _mode) {
		const { read, write, truncate, append, create, exclusive } = parseFlags(flags);
		const existing = resolveInode(this.db, path);
		if (existing === null) {
			if (!create) throw createWorkspaceError("ENOENT", `no such file: ${path}`, path);
			writeFileSync(this.db, path, /* @__PURE__ */ new Uint8Array(), {}, this.now);
		} else {
			if (existing.type !== "file") throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
			if (exclusive) throw createWorkspaceError("EEXIST", `path exists: ${path}`, path);
			if (truncate) writeFileSync(this.db, path, /* @__PURE__ */ new Uint8Array(), {}, this.now);
		}
		const stat$1 = stat(this.db, path);
		const fd = this.#nextFd++;
		this.#fds.set(fd, {
			path,
			position: append ? stat$1.size : 0,
			readable: read,
			writable: write,
			append
		});
		return fd;
	}
	stat(path, options) {
		return Promise.resolve(this.statSync(path, options));
	}
	statSync(path, _options) {
		const s = stat(this.db, path);
		return wrapStats({
			mode: s.mode,
			size: s.size,
			mtimeMs: s.mtime,
			ino: s.inode,
			isFile: s.isFile,
			isDirectory: s.isDirectory,
			isSymbolicLink: false,
			nlink: linkCount(this.db, s.inode)
		});
	}
	lstat(path, options) {
		return Promise.resolve(this.lstatSync(path, options));
	}
	lstatSync(path, _options) {
		const pending = findPendingWriteBuffer(this.db, path);
		if (pending?.pending !== void 0) return wrapStats({
			mode: pending.mode & 4095,
			size: pending.size,
			mtimeMs: pending.pending.mtime,
			ino: 0,
			isFile: true,
			isDirectory: false,
			isSymbolicLink: false,
			nlink: 1
		});
		const node = resolveInode(this.db, path, { followSymlinks: false });
		if (node === null) throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
		const isSymlink = node.type === "symlink";
		const size = isSymlink ? (node.linkTarget ?? "").length : node.type === "file" ? fileSize(this.db, node.inode) : 0;
		return wrapStats({
			mode: node.mode,
			size,
			mtimeMs: node.mtime,
			ino: node.inode,
			isFile: node.type === "file",
			isDirectory: node.type === "dir",
			isSymbolicLink: isSymlink,
			nlink: linkCount(this.db, node.inode)
		});
	}
	readdir(path, options) {
		return Promise.resolve(this.readdirSync(path, options));
	}
	readdirSync(path, options) {
		const entries = readdir(this.db, path);
		if (options?.withFileTypes === true) return entries.map((entry) => wrapDirent(entry));
		return entries.map((entry) => entry.name);
	}
	/**
	* The directory's entries with the type, permission bits and inode an
	* `lstat` of each reports, from one query. Not part of the
	* `@platformatic/vfs` provider surface.
	*/
	readdirEntriesSync(path) {
		return readdirEntries(this.db, path);
	}
	mkdir(path, options) {
		return Promise.resolve(this.mkdirSync(path, options));
	}
	mkdirSync(path, options) {
		mkdir(this.db, path, options ?? {}, this.now);
	}
	rmdir(path) {
		this.rmdirSync(path);
		return Promise.resolve();
	}
	rmdirSync(path) {
		flushPendingUnderNode(this.db, path, this.now);
		rm(this.db, path, {});
	}
	unlink(path) {
		this.unlinkSync(path);
		return Promise.resolve();
	}
	unlinkSync(path) {
		flushPendingUnderNode(this.db, path, this.now);
		flushPendingByPath(this.db, path, this.now);
		const target = resolveInode(this.db, path, { followSymlinks: false });
		rm(this.db, path, {});
		if (target !== null) {
			if (this.db.scalar("SELECT inode FROM vfs_nodes WHERE inode = ?", target.inode) === void 0) deleteWriteBuffer(this.db, target.inode);
		}
	}
	link(existingPath, newPath) {
		this.linkSync(existingPath, newPath);
		return Promise.resolve();
	}
	linkSync(existingPath, newPath) {
		flushPendingByPath(this.db, existingPath, this.now);
		flushPendingByPath(this.db, newPath, this.now);
		link(this.db, existingPath, newPath);
	}
	rename(oldPath, newPath) {
		this.renameSync(oldPath, newPath);
		return Promise.resolve();
	}
	renameSync(oldPath, newPath) {
		flushPendingUnderNode(this.db, oldPath, this.now);
		flushPendingUnderNode(this.db, newPath, this.now);
		flushPendingByPath(this.db, oldPath, this.now);
		flushPendingByPath(this.db, newPath, this.now);
		const displaced = resolveInode(this.db, newPath, { followSymlinks: false });
		rename(this.db, oldPath, newPath);
		if (displaced !== null) {
			if (this.db.scalar("SELECT inode FROM vfs_nodes WHERE inode = ?", displaced.inode) === void 0) deleteWriteBuffer(this.db, displaced.inode);
		}
	}
	readFile(path, options) {
		return Promise.resolve(this.readFileSync(path, options));
	}
	readFileSync(path, options) {
		const encoding = typeof options === "string" ? options : options?.encoding;
		const pending = findPendingWriteBuffer(this.db, path);
		if (pending !== void 0) {
			const snapshot = Buffer.alloc(pending.size);
			snapshot.set(pending.buf.subarray(0, pending.size));
			return encoding ? snapshot.toString(encoding) : snapshot;
		}
		const node = resolveInode(this.db, path);
		if (node === null) throw createWorkspaceError("ENOENT", `no such file: ${path}`, path);
		if (node.type !== "file") throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
		const buffered = getWriteBuffer(this.db, node.inode);
		if (buffered?.dirty) {
			const snapshot = Buffer.alloc(buffered.size);
			snapshot.set(buffered.buf.subarray(0, buffered.size));
			return encoding ? snapshot.toString(encoding) : snapshot;
		}
		const chunks = this.db.all("SELECT hash, size FROM vfs_chunks WHERE inode = ? ORDER BY idx", node.inode);
		let total = 0;
		for (const c of chunks) total += c.size;
		const out = Buffer.alloc(total);
		let offset = 0;
		for (const chunk of chunks) {
			const bytes = getBlobBytes(this.db, chunk.hash);
			if (bytes === void 0) throw createWorkspaceError("EIO", `missing blob bytes for ${path}`, path);
			out.set(bytes, offset);
			offset += bytes.byteLength;
		}
		return encoding ? out.toString(encoding) : out;
	}
	writeFile(path, data, options) {
		this.writeFileSync(path, data, options);
		return Promise.resolve();
	}
	writeFileSync(path, data, options) {
		const mode = typeof options === "string" ? void 0 : options?.mode;
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		writeFileSync(this.db, path, bytes, { mode }, this.now);
	}
	writeFileRangesSync(path, data, ranges, options) {
		const mode = typeof options === "string" ? void 0 : options?.mode;
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		writeFileRangesSync(this.db, path, bytes, ranges, { mode }, this.now);
	}
	createFileSync(path, options) {
		createFileSync(this.db, path, { mode: options?.mode }, this.now);
	}
	writeRangeSync(path, data, offset, options) {
		const mode = typeof options === "string" ? void 0 : options?.mode;
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		return writeRangeSync(this.db, path, bytes, offset, { mode }, this.now);
	}
	truncateFileSync(path, len) {
		truncateFileSync(this.db, path, len, this.now);
	}
	openWriteBufferSync(path) {
		openWriteBufferSync(this.db, path);
	}
	openWriteBufferForCreateSync(path, options) {
		openWriteBufferForCreateSync(this.db, path, { mode: options?.mode }, this.now);
	}
	releaseWriteBufferSync(path) {
		releaseWriteBufferSync(this.db, path, this.now);
	}
	chmodSync(path, mode) {
		const pending = findPendingWriteBuffer(this.db, path);
		if (pending !== void 0) {
			pending.mode = mode & 4095;
			return;
		}
		const node = resolveInode(this.db, path, { followSymlinks: false });
		if (node === null) throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
		const rev = incrementRev(this.db);
		this.db.run("UPDATE vfs_nodes SET mode = ?, rev = ? WHERE inode = ?", mode & 4095, rev, node.inode);
	}
	appendFile(_path, _data, _options) {
		return Promise.reject(notImplemented("appendFile"));
	}
	appendFileSync(_path, _data, _options) {
		throw notImplemented("appendFileSync");
	}
	exists(path) {
		return Promise.resolve(this.existsSync(path));
	}
	existsSync(path) {
		try {
			if (findPendingWriteBuffer(this.db, path) !== void 0) return true;
			return resolveInode(this.db, path) !== null;
		} catch {
			return false;
		}
	}
	copyFile(_src, _dest, _mode) {
		return Promise.reject(notImplemented("copyFile"));
	}
	copyFileSync(_src, _dest, _mode) {
		throw notImplemented("copyFileSync");
	}
	internalModuleStat(_path) {
		throw notImplemented("internalModuleStat");
	}
	realpath(path, _options) {
		return Promise.resolve(this.realpathSync(path));
	}
	realpathSync(path, _options) {
		const { path: canonical } = canonicalizePath(path);
		if (resolveInode(this.db, canonical) === null) throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
		return canonical;
	}
	access(path, _mode) {
		this.accessSync(path);
		return Promise.resolve();
	}
	accessSync(path, _mode) {
		if (resolveInode(this.db, path) === null) throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
	}
	closeSync(fd) {
		if (!this.#fds.delete(fd)) throw createWorkspaceError("EBADF", `unknown fd ${fd}`);
	}
	readSync(fd, buffer, offset, length, position) {
		const state = this.#fdOrThrow(fd);
		if (!state.readable) throw createWorkspaceError("EBADF", `fd ${fd} is not readable`);
		const startAt = position ?? state.position;
		const slice = readRangeSync(this.db, state.path, startAt, length);
		(buffer instanceof Buffer ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)).set(slice, offset);
		if (position === null || position === void 0) state.position = startAt + slice.byteLength;
		return slice.byteLength;
	}
	readRangeSync(path, offset, length) {
		const slice = readRangeSync(this.db, path, offset, length);
		return Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
	}
	writeSync(fd, buffer, offset = 0, length = buffer.byteLength - offset, position = null) {
		const state = this.#fdOrThrow(fd);
		if (!state.writable) throw createWorkspaceError("EBADF", `fd ${fd} is not writable`);
		let startAt;
		if (state.append) startAt = this.statSync(state.path).size;
		else {
			if (length === 0) this.statSync(state.path);
			startAt = position ?? state.position;
		}
		const view = buffer instanceof Buffer ? new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length) : new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
		writeRangeSync(this.db, state.path, view, startAt, {}, this.now);
		if (position === null || position === void 0) state.position = startAt + length;
		return length;
	}
	fstatSync(fd, _options) {
		const state = this.#fdOrThrow(fd);
		return this.statSync(state.path);
	}
	truncateSync(path, len) {
		const node = resolveInode(this.db, path);
		if (node === null) throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
		if (node.type !== "file") throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
		truncateFileSync(this.db, path, len, this.now);
	}
	ftruncateSync(fd, len) {
		const state = this.#fdOrThrow(fd);
		this.truncateSync(state.path, len);
	}
	#fdOrThrow(fd) {
		const state = this.#fds.get(fd);
		if (state === void 0) throw createWorkspaceError("EBADF", `unknown fd ${fd}`);
		return state;
	}
	readlink(path, _options) {
		return Promise.resolve(this.readlinkSync(path));
	}
	readlinkSync(path, _options) {
		return readlink(this.db, path);
	}
	symlink(target, path, _type) {
		this.symlinkSync(target, path);
		return Promise.resolve();
	}
	symlinkSync(target, path, _type) {
		symlink(this.db, target, path, this.now);
	}
	watch(path, options = {}) {
		return createWatcher(this.db, path, options, this.watchIntervalMs);
	}
	watchAsync(path, options = {}) {
		return createWatchAsyncIterable(this.watch(path, options));
	}
	watchFile(_path, _options, _listener) {
		throw notImplemented("watchFile");
	}
	unwatchFile(_path, _listener) {
		throw notImplemented("unwatchFile");
	}
};
function notImplemented(method) {
	return createWorkspaceError("ENOSYS", `SQLiteWorkspaceProvider.${method} is not implemented yet`);
}
const S_IFREG = 32768;
const S_IFDIR = 16384;
const S_IFLNK = 40960;
function fileTypeBits(input) {
	if (input.isDirectory) return S_IFDIR;
	if (input.isSymbolicLink) return S_IFLNK;
	if (input.isFile) return S_IFREG;
	return 0;
}
function linkCount(db, inode) {
	const count = db.scalar("SELECT COUNT(*) FROM vfs_dirents WHERE child_inode = ?", inode);
	return Math.max(1, count ?? 0);
}
function fileSize(db, inode) {
	const buffered = getWriteBuffer(db, inode);
	if (buffered?.dirty) return buffered.size;
	return db.scalar("SELECT size FROM vfs_nodes WHERE inode = ?", inode) ?? 0;
}
function wrapStats(input) {
	const mtime = new Date(input.mtimeMs);
	return {
		dev: 0,
		mode: input.mode & 4095 | fileTypeBits(input),
		nlink: input.nlink,
		uid: 0,
		gid: 0,
		rdev: 0,
		blksize: 4096,
		ino: input.ino,
		size: input.size,
		blocks: Math.ceil(input.size / 512),
		atimeMs: input.mtimeMs,
		mtimeMs: input.mtimeMs,
		ctimeMs: input.mtimeMs,
		birthtimeMs: input.mtimeMs,
		atime: mtime,
		mtime,
		ctime: mtime,
		birthtime: mtime,
		isFile: () => input.isFile,
		isDirectory: () => input.isDirectory,
		isSymbolicLink: () => input.isSymbolicLink,
		isBlockDevice: () => false,
		isCharacterDevice: () => false,
		isFIFO: () => false,
		isSocket: () => false
	};
}
function wrapDirent(input) {
	const fullPath = input.parentPath === "/" ? `/${input.name}` : `${input.parentPath}/${input.name}`;
	return {
		name: input.name,
		parentPath: input.parentPath,
		path: fullPath,
		isFile: () => input.isFile,
		isDirectory: () => input.isDirectory,
		isSymbolicLink: () => false,
		isBlockDevice: () => false,
		isCharacterDevice: () => false,
		isFIFO: () => false,
		isSocket: () => false
	};
}
function parseFlags(flags) {
	switch (flags) {
		case "r": return {
			read: true,
			write: false,
			create: false,
			truncate: false,
			append: false,
			exclusive: false
		};
		case "r+": return {
			read: true,
			write: true,
			create: false,
			truncate: false,
			append: false,
			exclusive: false
		};
		case "w": return {
			read: false,
			write: true,
			create: true,
			truncate: true,
			append: false,
			exclusive: false
		};
		case "w+": return {
			read: true,
			write: true,
			create: true,
			truncate: true,
			append: false,
			exclusive: false
		};
		case "wx": return {
			read: false,
			write: true,
			create: true,
			truncate: false,
			append: false,
			exclusive: true
		};
		case "wx+": return {
			read: true,
			write: true,
			create: true,
			truncate: false,
			append: false,
			exclusive: true
		};
		case "a": return {
			read: false,
			write: true,
			create: true,
			truncate: false,
			append: true,
			exclusive: false
		};
		case "a+": return {
			read: true,
			write: true,
			create: true,
			truncate: false,
			append: true,
			exclusive: false
		};
		case "ax": return {
			read: false,
			write: true,
			create: true,
			truncate: false,
			append: true,
			exclusive: true
		};
		case "ax+": return {
			read: true,
			write: true,
			create: true,
			truncate: false,
			append: true,
			exclusive: true
		};
		default: throw createWorkspaceError("EINVAL", `unsupported fs flag: ${flags}`);
	}
}
// src/sync/apply.ts
function hex(bytes) {
	let s = "";
	for (let i = 0; i < bytes.byteLength; i++) s += bytes[i].toString(16).padStart(2, "0");
	return s;
}
function removeReplaceableFinalEntry(db, path, incomingKind) {
	const existing = resolveInode(db, path, { followSymlinks: false });
	if (existing === null) return;
	if (incomingKind === "file" && existing.type === "file") return;
	removeInodeTreeAtPath(db, path, existing.inode, existing.type);
}
function removeInodeTreeAtPath(db, path, inode, type) {
	if (db.inTransaction) removeInodeTree(db, path, inode, type);
	else db.transactionSync(() => removeInodeTree(db, path, inode, type));
}
function removeInodeTree(db, path, inode, type) {
	invalidateResolveSubtree(db, canonicalizePath(path).path);
	const root = direntForPath(db, path, inode);
	const stack = [{
		path,
		parentInode: root.parentInode,
		name: root.name,
		inode,
		type,
		expanded: false
	}];
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === void 0) break;
		if (current.type === "dir" && !current.expanded) {
			const children = db.all(`SELECT d.name AS name, d.child_inode AS child_inode, n.type AS type
           FROM vfs_dirents d
           JOIN vfs_nodes n ON n.inode = d.child_inode
          WHERE d.parent_inode = ?`, current.inode);
			stack.push({
				...current,
				expanded: true
			});
			for (let i = children.length - 1; i >= 0; i--) {
				const child = children[i];
				const childPath = current.path === "/" ? `/${child.name}` : `${current.path}/${child.name}`;
				stack.push({
					path: childPath,
					parentInode: current.inode,
					name: child.name,
					inode: child.child_inode,
					type: child.type,
					expanded: false
				});
			}
			continue;
		}
		unlinkDirent(db, current.parentInode, current.name, current.inode, current.type);
	}
}
function direntForPath(db, path, inode) {
	const { parts, path: canonical } = canonicalizePath(path);
	if (parts.length === 0) throw new Error(`applyChanges: cannot structurally replace root ${canonical}`);
	const name = parts[parts.length - 1];
	const parent = resolveInode(db, parts.length === 1 ? "/" : `/${parts.slice(0, -1).join("/")}`, { followSymlinks: false });
	if (parent?.type !== "dir") throw new Error(`applyChanges: parent missing for structural replacement ${canonical}`);
	if (db.scalar("SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?", parent.inode, name) !== inode) throw new Error(`applyChanges: dirent mismatch for structural replacement ${canonical}`);
	return {
		parentInode: parent.inode,
		name
	};
}
function applyDirectoryEntry(db, entry) {
	const mode = entry.mode & 4095;
	const existing = resolveInode(db, entry.path, { followSymlinks: false });
	if (existing === null) {
		mkdir(db, entry.path, {
			mode,
			recursive: true
		}, () => entry.mtime);
		return;
	}
	if (existing.type !== "dir") {
		removeInodeTreeAtPath(db, entry.path, existing.inode, existing.type);
		mkdir(db, entry.path, {
			mode,
			recursive: true
		}, () => entry.mtime);
		return;
	}
	db.transactionSync(() => {
		const rev = incrementRev(db);
		db.run("UPDATE vfs_nodes SET mode = ?, mtime = ?, rev = ? WHERE inode = ?", mode, entry.mtime, rev, existing.inode);
	});
}
function ensureParentDirectories(db, path, mtime) {
	const { parts, path: canonical } = canonicalizePath(path);
	if (parts.length < 2) return { path: canonical };
	const parentPath = `/${parts.slice(0, -1).join("/")}`;
	if (resolveInodeWithoutSymlinks(db, parentPath)?.type === "dir") return { path: canonical };
	const reachableParent = resolveInode(db, parentPath);
	if (reachableParent?.type === "dir") {
		const resolvedParentPath = pathOf(db, reachableParent.inode);
		if (resolvedParentPath === null) throw new Error(`applyChanges: resolved parent is unreachable for ${canonical}`);
		const leafName = parts[parts.length - 1];
		const resolvedPath = resolvedParentPath === "/" ? `/${leafName}` : `${resolvedParentPath}/${leafName}`;
		return {
			path: resolvedPath,
			blockingRoot: readOnlyRootFor(db, resolvedPath)
		};
	}
	for (let i = 0; i < parts.length - 1; i++) {
		const ancestorPath = `/${parts.slice(0, i + 1).join("/")}`;
		const ancestor = resolveInode(db, ancestorPath, { followSymlinks: false });
		if (ancestor === null) {
			mkdirForSyncParents(db, parentPath, { recursive: true }, () => mtime);
			return { path: canonical };
		}
		if (ancestor.type === "dir") continue;
		const blockingRoot = readOnlyRootFor(db, ancestorPath);
		if (blockingRoot !== void 0) return {
			path: canonical,
			blockingRoot
		};
		removeInodeTreeAtPath(db, ancestorPath, ancestor.inode, ancestor.type);
		mkdirForSyncParents(db, parentPath, { recursive: true }, () => mtime);
		return { path: canonical };
	}
	return { path: canonical };
}
function isMissingPath(error) {
	const code = error?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}
function applyOne(db, entry, run) {
	const { objects, options, pulled, deferredDirs, skipped } = run;
	if (options.source === "upstream" && entry.kind !== "delete") {
		if (alreadyApplied(db, entry)) return void 0;
	}
	if (options.source === "upstream" && entry.kind === "delete" && tombstoneIsStale(db, entry, options, pulled)) {
		deferDirectoryDelete(db, entry, pulled, deferredDirs);
		return;
	}
	const blockingRoot = readOnlyRootFor(db, entry.path);
	if (blockingRoot !== void 0) {
		skipped.push({
			path: entry.path,
			mountRoot: blockingRoot,
			op: entry.kind === "delete" ? "delete" : "write",
			reason: "read-only"
		});
		return;
	}
	if (entry.kind === "delete") {
		try {
			rm(db, entry.path, {
				recursive: true,
				force: true
			});
		} catch (error) {
			if (!isMissingPath(error)) throw error;
		}
		return 0;
	}
	if (entry.kind === "dir" || entry.kind === "symlink") {
		const parentResult = ensureParentDirectories(db, entry.path, entry.mtime);
		if (parentResult.blockingRoot !== void 0) {
			skipped.push({
				path: entry.path,
				mountRoot: parentResult.blockingRoot,
				op: "write",
				reason: "read-only"
			});
			return;
		}
		if (entry.kind === "dir") applyDirectoryEntry(db, {
			...entry,
			path: parentResult.path
		});
		else {
			removeReplaceableFinalEntry(db, parentResult.path, "symlink");
			symlink(db, entry.target, parentResult.path, () => entry.mtime);
		}
		return 0;
	}
	const fileResult = applyFileEntry(db, entry, objects);
	if (fileResult.blockingRoot !== void 0) {
		skipped.push({
			path: entry.path,
			mountRoot: fileResult.blockingRoot,
			op: "write",
			reason: "read-only"
		});
		return;
	}
	return fileResult.total;
}
async function applyChanges(db, entries, objects, options = {}) {
	const deferral = openReapDeferral(db);
	try {
		const run = openRun(db, objects, options);
		const counts = {
			applied: 0,
			minted: 0
		};
		for await (const entry of entries) step(db, entry, run, deferral, counts);
		return finishRun(db, run, counts);
	} finally {
		deferral.close();
	}
}
function applyChangesSync(db, entries, objects, options = {}) {
	const deferral = openReapDeferral(db);
	try {
		const run = openRun(db, objects, options);
		const counts = {
			applied: 0,
			minted: 0
		};
		for (const entry of entries) step(db, entry, run, deferral, counts);
		return finishRun(db, run, counts);
	} finally {
		deferral.close();
	}
}
function openRun(db, objects, options) {
	return {
		objects,
		options,
		pulled: openPullContext(db, options),
		deferredDirs: [],
		skipped: []
	};
}
function step(db, entry, run, deferral, counts) {
	const revBefore = currentRev(db);
	try {
		if (deferral.hold(() => applyOne(db, entry, run)) !== void 0) counts.applied++;
	} finally {
		counts.minted += notePulledRevs(db, run.pulled, revBefore);
	}
}
function finishRun(db, run, counts) {
	const revBeforeSettle = currentRev(db);
	const applied = counts.applied + settleDeferredDirectories(db, run.deferredDirs, run.options, run.pulled, run.skipped);
	const minted = counts.minted + currentRev(db) - revBeforeSettle;
	return {
		applied,
		skipped: run.skipped,
		minted
	};
}
function applyFileEntry(db, entry, objects) {
	assertChunkWindows(entry.chunks, entry.path);
	const linking = pinHashes(db, entry.chunks.map((c) => c.hash));
	try {
		return linkFileEntry(db, entry, objects);
	} finally {
		linking.release();
	}
}
function linkFileEntry(db, entry, objects) {
	let total = 0;
	for (const c of entry.chunks) {
		total += c.size;
		const staged = stagedBlobSize(db, c.hash);
		if (staged === void 0) {
			const k = hex(c.hash);
			const bytes = objects.get(k);
			if (bytes === void 0) throw new Error(`applyChanges: missing object ${k} for ${entry.path}`);
			assertChunkSize(bytes.byteLength, c.size, c.hash, entry.path);
			stageBlob(db, c.hash, bytes);
			continue;
		}
		assertChunkSize(staged, c.size, c.hash, entry.path);
	}
	const parentResult = ensureParentDirectories(db, entry.path, entry.mtime);
	if (parentResult.blockingRoot !== void 0) return {
		total,
		blockingRoot: parentResult.blockingRoot
	};
	removeReplaceableFinalEntry(db, parentResult.path, "file");
	const { parts, path: canonical } = canonicalizePath(parentResult.path);
	linkStagedChunksSync(db, canonical, parts, entry.chunks, { mode: entry.mode }, entry.mtime);
	return { total };
}
function stagedBlobSize(db, hash) {
	return db.one(`SELECT b.size AS size
       FROM vfs_blobs b
       JOIN vfs_blob_bytes bb ON bb.hash = b.hash
      WHERE b.hash = ?
        AND length(bb.bytes) = b.size`, hash)?.size;
}
function assertChunkSize(actual, declared, hash, path) {
	if (actual === declared) return;
	throw new Error(`applyChanges: chunk ${hex(hash)} for ${path} declares ${declared} bytes but holds ${actual}`);
}
function openPullContext(db, options) {
	if (options.source !== "upstream" || options.receivedCursor !== void 0) return void 0;
	const backend = options.backend ?? "default";
	return {
		backend,
		clean: pushWindowIsEmpty(db, backend),
		revs: /* @__PURE__ */ new Set()
	};
}
function notePulledRevs(db, pulled, revBefore) {
	const revAfter = currentRev(db);
	if (pulled?.clean === true) for (let rev = revBefore + 1; rev <= revAfter; rev++) pulled.revs.add(rev);
	return revAfter - revBefore;
}
function tombstoneIsStale(db, entry, options, pulled) {
	const live = resolveInode(db, entry.path, { followSymlinks: false });
	if (live === null) return false;
	if (options.receivedCursor !== void 0) return compareChangeCursors({
		rev: entry.rev,
		path: entry.path
	}, options.receivedCursor) <= 0;
	if (entry.prior !== void 0 && matchesPrior(db, live.inode, live.type, entry.prior)) return false;
	const pushed = readPushCursor(db, pulled?.backend ?? options.backend ?? "default");
	return db.all(`WITH RECURSIVE tree(inode, path) AS (
       SELECT ?, ?
       UNION ALL
       SELECT d.child_inode,
              CASE WHEN tree.path = '/' THEN '/' || d.name ELSE tree.path || '/' || d.name END
         FROM vfs_dirents d JOIN tree ON d.parent_inode = tree.inode
     )
     SELECT tree.path AS path, n.rev AS rev
       FROM tree JOIN vfs_nodes n ON n.inode = tree.inode
      WHERE n.rev >= ?`, live.inode, entry.path, pushed.rev).some((node) => compareChangeCursors(node, pushed) > 0 && pulled?.revs.has(node.rev) !== true);
}
function matchesPrior(db, inode, type, prior) {
	if (type === "dir") {
		if ((db.scalar("SELECT COUNT(*) FROM vfs_dirents WHERE parent_inode = ?", inode) ?? 0) > 0) return false;
	}
	return versionFingerprint(db, inode) === prior;
}
function deferDirectoryDelete(db, entry, pulled, deferred) {
	if (pulled === void 0) return;
	if (resolveInode(db, entry.path, { followSymlinks: false })?.type === "dir") deferred.push(entry);
}
function settleDeferredDirectories(db, deferred, options, pulled, skipped) {
	let applied = 0;
	const ordered = [...deferred].sort((a, b) => b.path.length - a.path.length);
	for (const entry of ordered) {
		const live = resolveInode(db, entry.path, { followSymlinks: false });
		if (live?.type !== "dir") continue;
		if ((db.scalar("SELECT COUNT(*) FROM vfs_dirents WHERE parent_inode = ?", live.inode) ?? 0) > 0) continue;
		if (tombstoneIsStale(db, entry, options, pulled)) continue;
		const blockingRoot = readOnlyRootFor(db, entry.path);
		if (blockingRoot !== void 0) {
			skipped.push({
				path: entry.path,
				mountRoot: blockingRoot,
				op: "delete",
				reason: "read-only"
			});
			continue;
		}
		rm(db, entry.path, { force: true });
		applied++;
	}
	return applied;
}
function alreadyApplied(db, entry) {
	const live = resolveInode(db, entry.path, { followSymlinks: false });
	if (live === null) return false;
	if (entry.kind === "file") {
		if (live.type !== "file") return false;
		const row = db.one("SELECT manifest_hash FROM vfs_nodes WHERE inode = ?", live.inode);
		if (!row?.manifest_hash) return false;
		const wanted = computeManifestHash(entry.chunks);
		return uint8Equal(row.manifest_hash, wanted);
	}
	if (entry.kind === "dir") return live.type === "dir" && (live.mode & 4095) === (entry.mode & 4095);
	return live.type === "symlink" && live.linkTarget === entry.target && (live.mode & 4095) === (entry.mode & 4095);
}
function uint8Equal(a, b) {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
	return true;
}
// src/sync/blocks.ts
const PACK_THRESHOLD_ENTRIES = 2e4;
const PACK_THRESHOLD_BYTES = 104857600;
function toHex$2(bytes) {
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}
function objectsOf(entry) {
	return entry.kind === "file" ? entry.chunks.map((c) => ({
		hash: c.hash,
		size: c.size
	})) : [];
}
async function planBlock(db, request) {
	const { after, through, profile } = request;
	const entries = [];
	const objects = [];
	const seen = /* @__PURE__ */ new Set();
	let objectBytes = 0;
	let drained = true;
	const options = request.ignore === void 0 ? { through } : {
		through,
		ignore: request.ignore
	};
	for await (const entry of coalesceChanges(db, after, options)) {
		if (entries.length >= profile.maxEntries) {
			drained = false;
			break;
		}
		const candidates = objectsOf(entry).filter((o) => !seen.has(toHex$2(o.hash)));
		const unique = /* @__PURE__ */ new Map();
		for (const object of candidates) unique.set(toHex$2(object.hash), object);
		let addedBytes = 0;
		for (const object of unique.values()) addedBytes += object.size;
		if (entries.length > 0 && objectBytes + addedBytes > profile.maxBytes) {
			drained = false;
			break;
		}
		entries.push(entry);
		for (const [key, object] of unique) {
			seen.add(key);
			objects.push(object);
			objectBytes += object.size;
		}
	}
	const last = entries[entries.length - 1];
	const cursor = drained ? through : last === void 0 ? after : {
		rev: last.rev,
		path: last.path
	};
	return {
		entries,
		objects,
		objectBytes,
		cursor,
		drained
	};
}
async function selectMode(db, request) {
	const thresholdEntries = request.thresholdEntries ?? 2e4;
	const thresholdBytes = request.thresholdBytes ?? 104857600;
	const probeEntries = Math.max(request.profile.maxEntries, thresholdEntries);
	const probe = await planBlock(db, {
		...request,
		profile: {
			maxEntries: probeEntries,
			maxBytes: Number.MAX_SAFE_INTEGER
		}
	});
	const crossed = probe.entries.length >= thresholdEntries || probe.objectBytes >= thresholdBytes;
	const firstBlock = probe.entries.length <= request.profile.maxEntries && probe.objectBytes <= request.profile.maxBytes ? probe : await planBlock(db, request);
	return {
		mode: crossed ? "pack" : "entries",
		firstBlock
	};
}
// src/sync/change-pack.ts
const PACK_FORMAT_VERSION = 1;
const TRANSPORT_CHUNK_BYTES = 1048576;
const TAG_HEADER = 1;
const TAG_OBJECT = 2;
const TAG_ENTRY = 3;
const TAG_FOOTER = 4;
var PackProtocolError = class extends Error {
	code = "EPACK_PROTOCOL";
	constructor(message) {
		super(`change pack: ${message}`);
		this.name = "PackProtocolError";
	}
};
function toHex$1(bytes) {
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}
function fromHex(hex) {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}
function encodeEntry(entry) {
	if (entry.kind === "file") return JSON.stringify({
		...entry,
		chunks: entry.chunks.map((c) => ({
			hash: toHex$1(c.hash),
			size: c.size
		}))
	});
	return JSON.stringify(entry);
}
function decodeEntry(text) {
	const raw = JSON.parse(text);
	if (raw.kind === "file") {
		const chunks = raw.chunks.map((c) => ({
			hash: fromHex(c.hash),
			size: c.size
		}));
		return {
			...raw,
			chunks
		};
	}
	return raw;
}
function digestUpdate(state, bytes) {
	let hash = state;
	for (const byte of bytes) {
		hash ^= byte;
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return hash;
}
function frameRecord(tag, payload) {
	const framed = new Uint8Array(5 + payload.byteLength);
	framed[0] = tag;
	new DataView(framed.buffer).setUint32(1, payload.byteLength, false);
	framed.set(payload, 5);
	return framed;
}
function encodeChangePack(db, input) {
	const { block, after, target, generation } = input;
	const encoder = new TextEncoder();
	return new ReadableStream({ start(controller) {
		let digest = 2166136261;
		controller.enqueue(frameRecord(TAG_HEADER, encoder.encode(JSON.stringify({
			version: 1,
			generation
		}))));
		const emitted = /* @__PURE__ */ new Set();
		let objectBytes = 0;
		let objectCount = 0;
		const emitObjectsFor = (entry) => {
			if (entry.kind !== "file") return;
			for (const chunk of entry.chunks) {
				const key = toHex$1(chunk.hash);
				if (emitted.has(key)) continue;
				emitted.add(key);
				const row = db.one("SELECT bytes FROM vfs_blob_bytes WHERE hash = ?", chunk.hash);
				if (row === void 0) {
					controller.error(new PackProtocolError(`missing local object ${key}`));
					return;
				}
				const payload = new Uint8Array(row.bytes.byteLength + 32);
				payload.set(chunk.hash, 0);
				payload.set(row.bytes, 32);
				const record = frameRecord(TAG_OBJECT, payload);
				digest = digestUpdate(digest, record);
				controller.enqueue(record);
				objectBytes += row.bytes.byteLength;
				objectCount += 1;
			}
		};
		for (const entry of block.entries) {
			emitObjectsFor(entry);
			const record = frameRecord(TAG_ENTRY, encoder.encode(encodeEntry(entry)));
			digest = digestUpdate(digest, record);
			controller.enqueue(record);
		}
		const footer = {
			version: 1,
			generation,
			after,
			blockCursor: block.cursor,
			target,
			entryCount: input.corruptEntryCount ?? block.entries.length,
			objectCount,
			objectBytes,
			digest: digest.toString(16)
		};
		controller.enqueue(frameRecord(TAG_FOOTER, encoder.encode(JSON.stringify(footer))));
		controller.close();
	} }).pipeThrough(gzipStream("gzip")).pipeThrough(rechunk());
}
function gzipStream(format) {
	return new CompressionStream(format);
}
function gunzipStream(format) {
	return new DecompressionStream(format);
}
function rechunk() {
	let pending = /* @__PURE__ */ new Uint8Array(0);
	return new TransformStream({
		transform(chunk, controller) {
			const merged = new Uint8Array(pending.byteLength + chunk.byteLength);
			merged.set(pending, 0);
			merged.set(chunk, pending.byteLength);
			let offset = 0;
			while (merged.byteLength - offset >= TRANSPORT_CHUNK_BYTES) {
				controller.enqueue(merged.slice(offset, offset + TRANSPORT_CHUNK_BYTES));
				offset += TRANSPORT_CHUNK_BYTES;
			}
			pending = merged.slice(offset);
		},
		flush(controller) {
			if (pending.byteLength > 0) controller.enqueue(pending);
		}
	});
}
async function* readRecords(stream) {
	const reader = stream.getReader();
	let buffer = /* @__PURE__ */ new Uint8Array(0);
	let done = false;
	const pull = async () => {
		const { value, done: finished } = await reader.read();
		if (finished) {
			done = true;
			return false;
		}
		const merged = new Uint8Array(buffer.byteLength + value.byteLength);
		merged.set(buffer, 0);
		merged.set(value, buffer.byteLength);
		buffer = merged;
		return true;
	};
	try {
		while (true) {
			while (buffer.byteLength < 5 && !done) if (!await pull()) break;
			if (buffer.byteLength === 0 && done) return;
			if (buffer.byteLength < 5) throw new PackProtocolError("truncated record header");
			const length = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(1, false);
			while (buffer.byteLength < 5 + length && !done) if (!await pull()) break;
			if (buffer.byteLength < 5 + length) throw new PackProtocolError("truncated record payload");
			const framed = buffer.slice(0, 5 + length);
			yield {
				tag: buffer[0],
				payload: buffer.slice(5, 5 + length),
				framed
			};
			buffer = buffer.slice(5 + length);
		}
	} finally {
		reader.releaseLock();
	}
}
async function decodeChangePack(stream, options = {}) {
	const expectVersion = options.expectVersion ?? 1;
	const decoder = new TextDecoder();
	const entries = [];
	const objects = /* @__PURE__ */ new Map();
	let footer;
	let digest = 2166136261;
	let sawHeader = false;
	let source;
	try {
		source = stream.pipeThrough(gunzipStream("gzip"));
	} catch (error) {
		throw new PackProtocolError(`could not open gzip stream: ${String(error)}`);
	}
	try {
		for await (const record of readRecords(source)) {
			if (record.tag === TAG_HEADER) {
				const header = JSON.parse(decoder.decode(record.payload));
				if (header.version !== expectVersion) throw new PackProtocolError(`unsupported format version ${header.version}, expected ${expectVersion}`);
				if (options.expectGeneration !== void 0 && header.generation !== options.expectGeneration) throw new PackProtocolError(`generation ${header.generation} does not match expected ${options.expectGeneration}`);
				sawHeader = true;
				continue;
			}
			if (record.tag === TAG_OBJECT) {
				digest = digestUpdate(digest, record.framed);
				const hash = record.payload.slice(0, 32);
				objects.set(toHex$1(hash), record.payload.slice(32));
				continue;
			}
			if (record.tag === TAG_ENTRY) {
				digest = digestUpdate(digest, record.framed);
				entries.push(decodeEntry(decoder.decode(record.payload)));
				continue;
			}
			if (record.tag === TAG_FOOTER) {
				footer = JSON.parse(decoder.decode(record.payload));
				continue;
			}
			throw new PackProtocolError(`unknown record tag ${record.tag}`);
		}
	} catch (error) {
		if (error instanceof PackProtocolError) throw error;
		throw new PackProtocolError(`corrupt or truncated stream: ${String(error)}`);
	}
	if (!sawHeader) throw new PackProtocolError("missing header record");
	if (footer === void 0) throw new PackProtocolError("missing footer record");
	if (footer.entryCount !== entries.length) throw new PackProtocolError(`footer declares ${footer.entryCount} entries but body carried ${entries.length}`);
	if (footer.objectCount !== objects.size) throw new PackProtocolError(`footer declares ${footer.objectCount} objects but body carried ${objects.size}`);
	if (footer.digest !== digest.toString(16)) throw new PackProtocolError("body digest does not match footer");
	return {
		footer,
		entries,
		objects
	};
}
async function readPackFooter(stream) {
	return (await decodeChangePack(stream)).footer;
}
// src/sync/push.ts
async function* pushObjects(db, hashes) {
	for (const hash of hashes) {
		const row = db.one("SELECT bytes FROM vfs_blob_bytes WHERE hash = ?", hash);
		if (row === void 0) throw createWorkspaceError("EUNKNOWN_HASH", "pushObjects: missing blob for requested hash");
		yield {
			hash,
			bytes: row.bytes
		};
	}
}
// src/sync/fetch.ts
function fetchChanges(db, after, options = {}) {
	return coalesceChanges(db, after, options);
}
function fetchObjects(db, hashes) {
	return pushObjects(db, hashes);
}
function toHex(bytes) {
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}
const PROBE_BATCH = 100;
function hasObjects(db, hashes) {
	if (hashes.length === 0) return [];
	const present = /* @__PURE__ */ new Set();
	for (let i = 0; i < hashes.length; i += PROBE_BATCH) {
		const window = hashes.slice(i, i + PROBE_BATCH);
		const placeholders = window.map(() => "?").join(", ");
		const rows = db.all(`SELECT b.hash
         FROM vfs_blobs b
         JOIN vfs_blob_bytes bb ON bb.hash = b.hash
        WHERE b.hash IN (${placeholders})
          AND length(bb.bytes) = b.size`, ...window);
		for (const row of rows) present.add(toHex(row.hash));
	}
	const found = hashes.filter((h) => present.has(toHex(h)));
	if (found.length > 0) pinHashes(db, found, { leaseMs: HAS_OBJECTS_PIN_MS });
	return found;
}
// src/sync/invariant.ts
function assertAppliedPushCursor(appliedPushCursor, pushCursor) {
	if (compareChangeCursors(appliedPushCursor, pushCursor) < 0) throw new Error(`cross-side invariant violated: appliedPushCursor (${JSON.stringify(appliedPushCursor)}) < pushCursor (${JSON.stringify(pushCursor)})`);
}
// src/sync/operations.ts
const DEFAULT_BLOCK_PROFILE = {
	maxEntries: 2e3,
	maxBytes: 67108864
};
const MIN_BLOCK_PROFILE = {
	maxEntries: 500,
	maxBytes: 8388608
};
function rowToOperation(row) {
	const operation = {
		backend: row.backend,
		direction: row.direction,
		generation: row.generation,
		status: row.status,
		profile: {
			maxEntries: row.internal_max_entries,
			maxBytes: row.internal_max_bytes
		},
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
	if (row.target_rev !== null) operation.target = {
		rev: row.target_rev,
		path: row.target_path
	};
	if (row.mode !== null) operation.mode = row.mode;
	if (row.runtime_id !== null) operation.runtimeId = row.runtime_id;
	if (row.block_after_rev !== null) operation.blockAfter = {
		rev: row.block_after_rev,
		path: row.block_after_path
	};
	if (row.block_started_at !== null) operation.blockStartedAt = row.block_started_at;
	if (row.last_error !== null) operation.lastError = row.last_error;
	return operation;
}
function readOperation(db, backend = DEFAULT_BACKEND_ID, direction = "pull") {
	const row = db.one("SELECT * FROM _vfs_sync_operations WHERE backend = ? AND direction = ?", backend, direction);
	return row === void 0 ? void 0 : rowToOperation(row);
}
function newGeneration() {
	return crypto.randomUUID();
}
function beginCapture(db, backend = DEFAULT_BACKEND_ID, direction = "pull", now = Date.now()) {
	const generation = newGeneration();
	db.run(`INSERT INTO _vfs_sync_operations (
       backend, direction, generation, status,
       internal_max_entries, internal_max_bytes,
       created_at, updated_at
     ) VALUES (?, ?, ?, 'capturing', ?, ?, ?, ?)
     ON CONFLICT(backend, direction) DO UPDATE SET
       generation = excluded.generation,
       status = 'capturing',
       target_rev = NULL,
       target_path = NULL,
       runtime_id = NULL,
       mode = NULL,
       block_after_rev = NULL,
       block_after_path = NULL,
       block_started_at = NULL,
       internal_max_entries = excluded.internal_max_entries,
       internal_max_bytes = excluded.internal_max_bytes,
       updated_at = excluded.updated_at,
       last_error = NULL`, backend, direction, generation, DEFAULT_BLOCK_PROFILE.maxEntries, DEFAULT_BLOCK_PROFILE.maxBytes, now, now);
	return generation;
}
function fixTarget(db, backend, direction, generation, input, now = Date.now()) {
	db.run(`UPDATE _vfs_sync_operations
        SET status = 'pending',
            target_rev = ?,
            target_path = ?,
            mode = ?,
            runtime_id = ?,
            updated_at = ?
      WHERE backend = ? AND direction = ? AND generation = ? AND status = 'capturing'`, input.target.rev, input.target.path, input.mode, input.runtimeId ?? null, now, backend, direction, generation);
	const current = readOperation(db, backend, direction);
	return current?.generation === generation && current.status === "pending";
}
function openOperation(db, backend = DEFAULT_BACKEND_ID, direction = "pull", now = Date.now()) {
	return db.transactionSync(() => {
		const existing = readOperation(db, backend, direction);
		if (existing?.status === "pending") return {
			operation: existing,
			joined: true
		};
		const generation = beginCapture(db, backend, direction, now);
		const operation = readOperation(db, backend, direction);
		if (operation === void 0) throw new Error("dofs sync: operation row vanished immediately after capture");
		if (operation.generation !== generation) throw new Error("dofs sync: operation generation changed inside its own transaction");
		return {
			operation,
			joined: false
		};
	});
}
function completeOperation(db, backend, direction, generation) {
	if (readOperation(db, backend, direction)?.generation !== generation) return false;
	db.run("DELETE FROM _vfs_sync_operations WHERE backend = ? AND direction = ? AND generation = ?", backend, direction, generation);
	return true;
}
function failOperation(db, backend, direction, generation, status, error, now = Date.now()) {
	if (readOperation(db, backend, direction)?.generation !== generation) return false;
	db.run(`UPDATE _vfs_sync_operations
        SET status = ?, last_error = ?, updated_at = ?
      WHERE backend = ? AND direction = ? AND generation = ?`, status, error, now, backend, direction, generation);
	return true;
}
function markBlockStarted(db, backend, direction, generation, after, now = Date.now()) {
	if (readOperation(db, backend, direction)?.generation !== generation) return false;
	db.run(`UPDATE _vfs_sync_operations
        SET block_after_rev = ?, block_after_path = ?, block_started_at = ?, updated_at = ?
      WHERE backend = ? AND direction = ? AND generation = ?`, after.rev, after.path, now, now, backend, direction, generation);
	return true;
}
function clearBlockMarker(db, backend, direction, generation, now = Date.now()) {
	if (readOperation(db, backend, direction)?.generation !== generation) return false;
	db.run(`UPDATE _vfs_sync_operations
        SET block_after_rev = NULL, block_after_path = NULL,
            block_started_at = NULL, updated_at = ?
      WHERE backend = ? AND direction = ? AND generation = ?`, now, backend, direction, generation);
	return true;
}
function shrinkBlockProfile(db, backend, direction, generation, now = Date.now()) {
	const existing = readOperation(db, backend, direction);
	if (existing?.generation !== generation) return void 0;
	const next = {
		maxEntries: Math.max(MIN_BLOCK_PROFILE.maxEntries, Math.floor(existing.profile.maxEntries / 2)),
		maxBytes: Math.max(MIN_BLOCK_PROFILE.maxBytes, Math.floor(existing.profile.maxBytes / 2))
	};
	db.run(`UPDATE _vfs_sync_operations
        SET internal_max_entries = ?, internal_max_bytes = ?, updated_at = ?
      WHERE backend = ? AND direction = ? AND generation = ?`, next.maxEntries, next.maxBytes, now, backend, direction, generation);
	return next;
}
function recordSkip(db, backend, direction, generation, path, reason, now = Date.now()) {
	db.run(`INSERT INTO _vfs_sync_skips (backend, direction, generation, path, reason, at)
       VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(backend, direction, generation, path) DO UPDATE SET
       reason = excluded.reason, at = excluded.at`, backend, direction, generation, path, reason, now);
}
function readSkips(db, backend = DEFAULT_BACKEND_ID, direction = "pull") {
	return db.all(`SELECT generation, path, reason, at
         FROM _vfs_sync_skips
        WHERE backend = ? AND direction = ?
        ORDER BY at, path`, backend, direction).map((row) => ({
		generation: row.generation,
		path: row.path,
		reason: row.reason,
		at: row.at
	}));
}
function pruneSkips(db, backend, direction, generation) {
	db.run("DELETE FROM _vfs_sync_skips WHERE backend = ? AND direction = ? AND generation != ?", backend, direction, generation);
}
export { DEFAULT_BLOCK_PROFILE, DEFAULT_IGNORE, Database, MANIFEST_VERSION, MIN_BLOCK_PROFILE, PACK_FORMAT_VERSION, PACK_THRESHOLD_BYTES, PACK_THRESHOLD_ENTRIES, PackProtocolError, ROOT_INODE, RecordingStorage, SCHEMA_VERSION, SQLiteWorkspaceProvider, WorkspaceFilesystem, applyChanges, applyChangesSync, assertAppliedPushCursor, assertNotReadOnly, beginCapture, buildManifest, chmod, clearBlockMarker, coalesceChanges, compareChangeCursors, completeOperation, createWorkspaceError, currentRev, decodeChangePack, encodeChangePack, failOperation, fetchChanges, fetchObjects, fixTarget, getReadOnlyMountRoots, hasObjects, initializeSchema, invalidateReadOnlyMountCache, isIgnored, link, lstat, markBlockStarted, materialiseChange, openOperation, pinObjects, planBlock, pruneSkips, pushObjects, pushWindowIsEmpty, readFetchCursor, readOnlyRootFor, readOperation, readPackFooter, readPushCursor, readSkips, readWatermark, readlink, recordSkip, rename, selectMode, shrinkBlockProfile, stageBlob, stat, symlink, writeFetchCursor, writePushCursor, writeWatermark };

//# sourceMappingURL=index.js.map