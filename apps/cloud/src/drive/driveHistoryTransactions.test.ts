import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { makeOperations } from "./DriveHistory.ts";
import { DriveStore, layer } from "./DriveStore.ts";

const TARGET = "history-transactions";
const SOURCE = "original";
const database = layer(TARGET).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

it.effect("reads transfer bytes outside transactions while keeping staged packs invisible", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* DriveStore;
    yield* store.initialize;
    let transactionDepth = 0;
    let byteReads = 0;
    const tracked = new Proxy(sql, {
      get(target, property, receiver) {
        if (property !== "withTransaction") return Reflect.get(target, property, receiver);
        return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            transactionDepth++;
            return yield* target
              .withTransaction(effect)
              .pipe(Effect.ensuring(Effect.sync(() => transactionDepth--)));
          });
      },
    });
    const operations = makeOperations({
      driveId: TARGET,
      sql: tracked,
      role: () => Effect.succeed("owner"),
      ref: store.ref,
      remote: store.remote,
      setRemote: store.setRemote,
      setRef: () => Effect.void,
    });
    const data = yield* Stream.unfold(0, (index) =>
      Effect.gen(function* () {
        if (index > 16) return undefined;
        expect(transactionDepth).toBe(0);
        expect((yield* store.refs(null)).packs).toEqual([]);
        const record =
          index < 16
            ? {
                _tag: "pack",
                row: {
                  seq: index + 1,
                  name: `inherited-${index}`,
                  size: 32,
                  object_count: 0,
                  storage_drive_id: SOURCE,
                },
              }
            : { _tag: "end" };
        byteReads++;
        return [new TextEncoder().encode(`${JSON.stringify(record)}\n`), index + 1] as const;
      }),
    ).pipe(Stream.toReadableStreamEffect({ strategy: { highWaterMark: 0 } }));
    expect(
      yield* operations.startFromHistory("owner", {
        sourceDriveId: SOURCE,
        head: null,
        remote: null,
        data,
      }),
    ).toEqual({ _tag: "ok", sourceDriveId: SOURCE, head: null });
    expect(byteReads).toBe(17);
    expect((yield* store.refs(null)).packs).toHaveLength(16);
  }).pipe(Effect.provide(database)),
);

it.effect("does not publish staged history over a destination changed during transfer", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* DriveStore;
    yield* store.initialize;
    const operations = makeOperations({
      driveId: TARGET,
      sql,
      role: () => Effect.succeed("owner"),
      ref: store.ref,
      remote: store.remote,
      setRemote: store.setRemote,
      setRef: () => Effect.void,
    });
    const data = yield* Stream.unfold(0, (index) =>
      Effect.gen(function* () {
        if (index > 8) return undefined;
        if (index === 8) {
          yield* sql`INSERT INTO refs (name, oid, updated_by, updated_at)
          VALUES ('main', 'existing-work', 'owner', 0)`;
        }
        const record =
          index < 8
            ? {
                _tag: "pack",
                row: {
                  seq: index + 1,
                  name: `inherited-${index}`,
                  size: 32,
                  object_count: 0,
                  storage_drive_id: SOURCE,
                },
              }
            : { _tag: "end" };
        return [new TextEncoder().encode(`${JSON.stringify(record)}\n`), index + 1] as const;
      }),
    ).pipe(Stream.toReadableStreamEffect({ strategy: { highWaterMark: 0 } }));
    expect(
      yield* operations.startFromHistory("owner", {
        sourceDriveId: SOURCE,
        head: null,
        remote: null,
        data,
      }),
    ).toMatchObject({ _tag: "refused" });
    expect(yield* store.ref("main")).toBe("existing-work");
    expect(yield* sql`SELECT * FROM drive_history_origin`).toEqual([]);
    expect((yield* store.refs(null)).packs).toEqual([]);
  }).pipe(Effect.provide(database)),
);
