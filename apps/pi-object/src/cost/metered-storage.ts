// A proxy over a Durable Object's storage that counts the SQLite rows each statement reads and writes.
// The Workspace reaches SQLite only through `storage.sql.exec` and `storage.transactionSync`, so counting there
// covers every row it touches. Counts are reported once per cursor, when the statement's result is consumed.

export type RowsReport = (rowsRead: number, rowsWritten: number) => void;

interface CursorLike {
  toArray(): unknown[];
  one(): unknown;
  rowsRead: number;
  rowsWritten: number;
  [Symbol.iterator](): Iterator<unknown>;
}

function meterCursor(cursor: CursorLike, report: RowsReport): CursorLike {
  let reported = false;
  const done = () => {
    if (reported) return;
    reported = true;
    report(cursor.rowsRead, cursor.rowsWritten);
  };
  return new Proxy(cursor, {
    get(target, key) {
      if (key === "toArray") return () => {
        const rows = target.toArray();
        done();
        return rows;
      };
      if (key === "one") return () => {
        const row = target.one();
        done();
        return row;
      };
      if (key === Symbol.iterator) return function* () {
        for (const row of target) yield row;
        done();
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as CursorLike;
}

// The storage's SQL surface, structurally: the real DurableObjectStorage and a test fake both satisfy it.
interface SqlLike {
  exec: (query: string, ...bindings: unknown[]) => CursorLike;
}

export function meterStorage<S extends { sql: SqlLike }>(storage: S, report: RowsReport): S {
  const sql = storage.sql;
  const meteredSql = new Proxy(sql, {
    get(target, key) {
      if (key === "exec") return (query: string, ...bindings: unknown[]) =>
        meterCursor(target.exec(query, ...bindings), report);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(storage, {
    get(target, key) {
      if (key === "sql") return meteredSql;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
