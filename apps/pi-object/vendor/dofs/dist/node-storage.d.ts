import { n as SQLCursorLike, t as DurableObjectStorageLike } from "./types-DxpMkQ_t.js";
export type JournalMode = "wal" | "delete" | "memory";
export type SynchronousLevel = "off" | "normal" | "full";
export interface NodeSQLiteStorageOptions {
  location: string;
  journalMode?: JournalMode;
  cacheSizeBytes?: number;
  mmapSizeBytes?: number;
  synchronous?: SynchronousLevel;
  tempStore?: "default" | "file" | "memory";
  busyTimeoutMs?: number;
}
export interface CheckpointResult {
  walFrames: number;
  sizeBytes: number;
  durationMs: number;
}
export declare class NodeSQLiteStorage implements DurableObjectStorageLike {
  #private;
  readonly location: string;
  private readonly db;
  private readonly cache;
  readonly sql: {
    exec: <Row extends object>(query: string, ...bindings: unknown[]) => SQLCursorLike<Row>;
  };
  constructor(options: NodeSQLiteStorageOptions);
  private applyPragmas;
  transactionSync<T>(closure: () => T): T;
  checkpoint(): CheckpointResult;
  sizeBytes(): number;
  freelistCount(): number;
  private scalarNumber;
  close(): void;
}
//# sourceMappingURL=node-storage.d.ts.map