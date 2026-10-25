import * as NodeSqlite from "node:sqlite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { harnessReleaseLedgerLayer } from "./HarnessReleaseLedgerService.ts";
import type { HarnessReleaseSqliteDatabase } from "./HarnessReleaseSqliteStore.ts";

export const makeHarnessReleaseLedgerTestDatabase = () => {
  const database = new NodeSqlite.DatabaseSync(":memory:");
  const storage: HarnessReleaseSqliteDatabase = {
    sql: {
      exec(query, ...bindings) {
        const statement = database.prepare(query);
        return statement.columns().length > 0
          ? statement.all(...bindings)
          : (statement.run(...bindings), []);
      },
    },
    transactionSync(callback) {
      database.exec("BEGIN");
      try {
        const result = callback();
        database.exec("COMMIT");
        return result;
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
  };
  return { database, storage };
};

class HarnessReleaseLedgerTestDatabase extends Context.Service<
  HarnessReleaseLedgerTestDatabase,
  ReturnType<typeof makeHarnessReleaseLedgerTestDatabase>
>()("@signalbox/cloud/harnessReleases/testing/HarnessReleaseLedgerTestDatabase") {}

/** Each memory user gets a real, isolated ledger for its runtime lifetime. */
export const harnessReleaseLedgerTestingLayer = () =>
  Layer.unwrap(
    Effect.map(HarnessReleaseLedgerTestDatabase, ({ storage }) =>
      harnessReleaseLedgerLayer(storage),
    ),
  ).pipe(
    Layer.provide(
      Layer.effect(
        HarnessReleaseLedgerTestDatabase,
        Effect.acquireRelease(Effect.sync(makeHarnessReleaseLedgerTestDatabase), ({ database }) =>
          Effect.sync(() => database.close()),
        ),
      ),
    ),
  );
