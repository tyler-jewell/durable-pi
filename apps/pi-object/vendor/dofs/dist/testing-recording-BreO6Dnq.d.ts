import { n as SQLCursorLike, r as SQLStorageLike, t as DurableObjectStorageLike } from "./types-DxpMkQ_t.js";
declare class Database {
  #private;
  readonly sql: SQLStorageLike;
  readonly transactionSync: <T>(closure: () => T) => T;
  constructor(storage: DurableObjectStorageLike);
  get inTransaction(): boolean;
  run(query: string, ...bindings: unknown[]): void;
  all<Row extends object>(query: string, ...bindings: unknown[]): Row[];
  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined;
  scalar<T>(query: string, ...bindings: unknown[]): T | undefined;
}
declare function pinObjects(db: Database, hashes: Iterable<Uint8Array>): {
  release(): void;
};
declare function isPinned(db: Database, hash: Uint8Array): boolean;
interface ExecutedStatement {
  query: string;
  bindings: unknown[];
}
declare class RecordingStorage implements DurableObjectStorageLike {
  readonly statements: ExecutedStatement[];
  readonly sql: {
    exec: <Row extends object = Record<string, unknown>>(query: string, ...bindings: unknown[]) => SQLCursorLike<Row>;
  };
  private readonly meta;
  constructor(seed?: {
    schemaVersion?: number;
    rev?: number;
  });
  transactionSync<T>(closure: () => T): T;
  private rowsFor;
}
export { Database as a, pinObjects as i, RecordingStorage as n, isPinned as r, ExecutedStatement as t };
//# sourceMappingURL=testing-recording-BreO6Dnq.d.ts.map