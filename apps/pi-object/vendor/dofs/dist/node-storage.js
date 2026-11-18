import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
// src/node-storage.ts
const IN_MEMORY_LOCATION = ":memory:";
const DEFAULT_CACHE_SIZE_BYTES = 67108864;
const DEFAULT_MMAP_SIZE_BYTES = 268435456;
const DEFAULT_BUSY_TIMEOUT_MS = 5e3;
var NodeCursor = class {
	rows;
	constructor(rows) {
		this.rows = rows;
	}
	toArray() {
		return this.rows;
	}
};
var NodeSQLiteStorage = class {
	location;
	db;
	cache = /* @__PURE__ */ new Map();
	#transactionDepth = 0;
	sql;
	constructor(options) {
		this.location = options.location;
		const onDisk = options.location !== IN_MEMORY_LOCATION;
		if (onDisk) mkdirSync(dirname(options.location), { recursive: true });
		this.db = new DatabaseSync(options.location);
		this.applyPragmas(options, onDisk);
		this.sql = { exec: (query, ...bindings) => {
			let stmt = this.cache.get(query);
			if (stmt === void 0) {
				stmt = this.db.prepare(query);
				this.cache.set(query, stmt);
			}
			const normalized = bindings.map(toSQLiteValue);
			return new NodeCursor(stmt.all(...normalized) ?? []);
		} };
	}
	applyPragmas(options, onDisk) {
		const journalMode = options.journalMode ?? (onDisk ? "wal" : void 0);
		if (journalMode !== void 0) this.db.exec(`PRAGMA journal_mode = ${journalMode}`);
		const synchronous = options.synchronous ?? (onDisk ? "normal" : void 0);
		if (synchronous !== void 0) this.db.exec(`PRAGMA synchronous = ${synchronous}`);
		const cacheSizeBytes = options.cacheSizeBytes ?? (onDisk ? DEFAULT_CACHE_SIZE_BYTES : void 0);
		if (cacheSizeBytes !== void 0) {
			const kibibytes = Math.max(1, Math.floor(cacheSizeBytes / 1024));
			this.db.exec(`PRAGMA cache_size = -${kibibytes}`);
		}
		const mmapSizeBytes = options.mmapSizeBytes ?? (onDisk ? DEFAULT_MMAP_SIZE_BYTES : void 0);
		if (mmapSizeBytes !== void 0) this.db.exec(`PRAGMA mmap_size = ${Math.max(0, Math.floor(mmapSizeBytes))}`);
		const tempStore = options.tempStore ?? (onDisk ? "memory" : void 0);
		if (tempStore !== void 0) this.db.exec(`PRAGMA temp_store = ${tempStore}`);
		const busyTimeoutMs = options.busyTimeoutMs ?? (onDisk ? DEFAULT_BUSY_TIMEOUT_MS : void 0);
		if (busyTimeoutMs !== void 0) this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
	}
	transactionSync(closure) {
		if (this.#transactionDepth > 0) {
			const savepoint = `nested_${this.#transactionDepth}`;
			this.db.exec(`SAVEPOINT ${savepoint}`);
			this.#transactionDepth++;
			try {
				const result = closure();
				this.db.exec(`RELEASE ${savepoint}`);
				return result;
			} catch (error) {
				this.db.exec(`ROLLBACK TO ${savepoint}`);
				this.db.exec(`RELEASE ${savepoint}`);
				throw error;
			} finally {
				this.#transactionDepth--;
			}
		}
		this.db.exec("BEGIN");
		this.#transactionDepth++;
		try {
			const result = closure();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		} finally {
			this.#transactionDepth--;
		}
	}
	checkpoint() {
		const startedAt = Date.now();
		let walFrames = 0;
		if (this.location !== IN_MEMORY_LOCATION) {
			const row = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all()[0];
			if (row !== void 0) {
				const values = Object.values(row);
				walFrames = typeof values[1] === "number" && values[1] > 0 ? values[1] : 0;
			}
		}
		return {
			walFrames,
			sizeBytes: this.sizeBytes(),
			durationMs: Date.now() - startedAt
		};
	}
	sizeBytes() {
		return this.scalarNumber("PRAGMA page_count") * this.scalarNumber("PRAGMA page_size");
	}
	freelistCount() {
		return this.scalarNumber("PRAGMA freelist_count");
	}
	scalarNumber(pragma) {
		const row = this.db.prepare(pragma).all()[0];
		if (row === void 0) return 0;
		const value = Object.values(row)[0];
		return typeof value === "number" ? value : 0;
	}
	close() {
		this.cache.clear();
		this.db.close();
	}
};
function toSQLiteValue(value) {
	if (value === void 0 || value === null) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (value instanceof Uint8Array) return value;
	if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
	throw new TypeError(`NodeSQLiteStorage cannot bind value of type ${typeof value}`);
}
export { NodeSQLiteStorage };

//# sourceMappingURL=node-storage.js.map