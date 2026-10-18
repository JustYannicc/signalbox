import type { DatabaseReader, DatabaseWriter, Scheduler } from "lunorash/server";

/** Accept only contexts created by Lunora's native query or mutation dispatch. */
export function toLunoraReadContext(context: { readonly db: unknown }): {
  readonly db: DatabaseReader;
} {
  assertDatabase(context.db, ["get", "query", "asId"]);
  // Codegen narrows asId to declared table names; the base type quantifies over every string.
  // The runtime object is the same transaction-scoped engine database in both types.
  return { db: context.db as DatabaseReader };
}

/** Accept only a native mutation context; this bridge does not open a transaction. */
export function toLunoraWriteContext(context: {
  readonly db: unknown;
  readonly scheduler?: Pick<Scheduler, "runAfter">;
}): {
  readonly db: DatabaseWriter;
  readonly scheduler?: Pick<Scheduler, "runAfter">;
} {
  assertDatabase(context.db, ["get", "query", "asId", "insert", "replace", "patch", "delete"]);
  // Preserve the native writer and its deferred scheduler so rows, receipts and jobs commit together.
  return {
    db: context.db as DatabaseWriter,
    ...(context.scheduler === undefined ? {} : { scheduler: context.scheduler }),
  };
}

function assertDatabase(database: unknown, methods: readonly string[]): void {
  if (typeof database !== "object" || database === null) {
    throw new TypeError("Expected a native Lunora database context");
  }
  for (const method of methods) {
    if (!(method in database) || typeof Reflect.get(database, method) !== "function") {
      throw new TypeError(`Native Lunora database context is missing ${method}`);
    }
  }
}
