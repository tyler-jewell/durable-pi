interface SQLCursorLike<Row extends object = Record<string, unknown>> {
  toArray(): Row[];
}
interface SQLStorageLike {
  exec(query: string, ...bindings: unknown[]): SQLCursorLike;
}
interface DurableObjectStorageLike {
  sql: SQLStorageLike;
  transaction?<T>(closure: () => T | Promise<T>): T | Promise<T>;
  transactionSync?<T>(closure: () => T): T;
}
export { SQLCursorLike as n, SQLStorageLike as r, DurableObjectStorageLike as t };
//# sourceMappingURL=types-DxpMkQ_t.d.ts.map