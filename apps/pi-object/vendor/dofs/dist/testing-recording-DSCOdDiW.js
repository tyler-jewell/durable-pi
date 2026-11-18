// src/fs/blobCache.ts
const CHUNK_CACHE_MAX_ENTRIES = 16;
const caches = /* @__PURE__ */ new WeakMap();
function cacheFor(db) {
	let cache = caches.get(db);
	if (cache === void 0) {
		cache = /* @__PURE__ */ new Map();
		caches.set(db, cache);
	}
	return cache;
}
function hashKey(hash) {
	let out = "";
	for (let i = 0; i < hash.byteLength; i++) out += String.fromCharCode(hash[i]);
	return out;
}
function getBlobBytes(db, hash) {
	const cache = cacheFor(db);
	const key = hashKey(hash);
	const cached = cache.get(key);
	if (cached !== void 0) {
		cache.delete(key);
		cache.set(key, cached);
		return cached;
	}
	const row = db.one("SELECT bytes FROM vfs_blob_bytes WHERE hash = ?", hash);
	if (row === void 0) return void 0;
	cache.set(key, row.bytes);
	while (cache.size > CHUNK_CACHE_MAX_ENTRIES) {
		const first = cache.keys().next();
		if (first.done === true) break;
		cache.delete(first.value);
	}
	return row.bytes;
}
function evictBlob(db, hash) {
	caches.get(db)?.delete(hashKey(hash));
}
function clearBlobCache(db) {
	caches.delete(db);
}
// src/fs/pins.ts
const STREAM_IDLE_LEASE_MS = 3e5;
const HAS_OBJECTS_PIN_MS = 6e5;
const PRUNE_INTERVAL_MS = 1e3;
const registries = /* @__PURE__ */ new WeakMap();
function registryFor(db) {
	let registry = registries.get(db);
	if (registry === void 0) {
		registry = {
			byHash: /* @__PURE__ */ new Map(),
			leased: /* @__PURE__ */ new Set(),
			lastPrune: 0
		};
		registries.set(db, registry);
	}
	return registry;
}
function expired(lease, now) {
	return lease.expiresAt <= now;
}
function register(registry, lease, key) {
	let holders = registry.byHash.get(key);
	if (holders === void 0) {
		holders = /* @__PURE__ */ new Set();
		registry.byHash.set(key, holders);
	}
	holders.add(lease);
}
function unregister(registry, lease) {
	for (const key of lease.keys) {
		const holders = registry.byHash.get(key);
		if (holders === void 0) continue;
		holders.delete(lease);
		if (holders.size === 0) registry.byHash.delete(key);
	}
	registry.leased.delete(lease);
}
function prune(registry, now) {
	if (now - registry.lastPrune < PRUNE_INTERVAL_MS) return;
	registry.lastPrune = now;
	for (const lease of registry.leased) if (expired(lease, now)) unregister(registry, lease);
}
function pinHashes(db, hashes, options = {}) {
	const registry = registryFor(db);
	const now = Date.now();
	prune(registry, now);
	const lease = {
		keys: /* @__PURE__ */ new Set(),
		leaseMs: options.leaseMs,
		expiresAt: options.leaseMs === void 0 ? Number.POSITIVE_INFINITY : now + options.leaseMs,
		released: false
	};
	if (lease.leaseMs !== void 0) registry.leased.add(lease);
	const add = (hash) => {
		if (lease.released) return;
		const key = hashKey(hash);
		lease.keys.add(key);
		register(registry, lease, key);
	};
	for (const hash of hashes) add(hash);
	return {
		add,
		renew() {
			if (lease.released || lease.leaseMs === void 0) return;
			const at = Date.now();
			if (expired(lease, at)) {
				registry.leased.add(lease);
				for (const key of lease.keys) register(registry, lease, key);
			}
			lease.expiresAt = at + lease.leaseMs;
		},
		release() {
			if (lease.released) return;
			lease.released = true;
			unregister(registry, lease);
		}
	};
}
function pinObjects(db, hashes) {
	const pin = pinHashes(db, hashes);
	return { release: () => pin.release() };
}
function isPinned(db, hash) {
	return isKeyPinned(db, hashKey(hash));
}
function isKeyPinned(db, key) {
	const registry = registries.get(db);
	const holders = registry?.byHash.get(key);
	if (registry === void 0 || holders === void 0) return false;
	const now = Date.now();
	for (const lease of holders) {
		if (!expired(lease, now)) return true;
		unregister(registry, lease);
	}
	return false;
}
// src/testing-recording.ts
var TestCursor = class {
	rows;
	constructor(rows) {
		this.rows = rows;
	}
	toArray() {
		return this.rows;
	}
};
var RecordingStorage = class {
	statements = [];
	sql = { exec: (query, ...bindings) => {
		this.statements.push({
			query,
			bindings
		});
		return new TestCursor(this.rowsFor(query, bindings));
	} };
	meta = /* @__PURE__ */ new Map();
	constructor(seed) {
		if (seed?.schemaVersion !== void 0) this.meta.set("schema_version", seed.schemaVersion);
		if (seed?.rev !== void 0) this.meta.set("rev", seed.rev);
	}
	transactionSync(closure) {
		return closure();
	}
	rowsFor(query, bindings) {
		const normalized = query.replace(/\s+/g, " ").trim().toLowerCase();
		if (normalized === "select v from vfs_meta where k = ?") {
			const key = String(bindings[0]);
			const value = this.meta.get(key);
			return value === void 0 ? [] : [{ v: value }];
		}
		if (normalized.startsWith("insert or ignore into vfs_meta")) {
			const key = String(bindings[0]);
			const value = Number(bindings[1]);
			if (!this.meta.has(key)) this.meta.set(key, value);
		}
		if (normalized.startsWith("update vfs_meta set v = ? where k = ?")) this.meta.set(String(bindings[1]), Number(bindings[0]));
		return [];
	}
};
export { isPinned as a, clearBlobCache as c, hashKey as d, isKeyPinned as i, evictBlob as l, HAS_OBJECTS_PIN_MS as n, pinHashes as o, STREAM_IDLE_LEASE_MS as r, pinObjects as s, RecordingStorage as t, getBlobBytes as u };

//# sourceMappingURL=testing-recording-DSCOdDiW.js.map