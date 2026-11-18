import { a as isPinned, t as RecordingStorage } from "./testing-recording-DSCOdDiW.js";
import { NodeSQLiteStorage } from "./node-storage.js";
// src/testing.ts
var SQLiteTestStorage = class extends NodeSQLiteStorage {
	constructor() {
		super({ location: ":memory:" });
	}
};
export { RecordingStorage, SQLiteTestStorage, isPinned };

//# sourceMappingURL=testing.js.map