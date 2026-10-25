import {
  NonNegativeInt,
  TerminalSessionSnapshot,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type ThreadId,
} from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { terminalHistoryTail } from "../thread/terminalHistory.ts";
import type { TerminalDelivery } from "../thread/terminalSync.ts";
import * as UserContexts from "./UserContexts.ts";
import {
  makeUserTerminalStreams,
  terminalKey,
  toSummary,
  type StoredTerminal,
  type StoredState,
  type TerminalChange,
} from "./userTerminalStreams.ts";

const MAX_PENDING_CHANGES = 32;

export class UserTerminals extends Context.Service<
  UserTerminals,
  {
    /** Idempotently applies one thread's terminal outbox delivery. */
    readonly record: (delivery: TerminalDelivery) => Effect.Effect<void, SqlError>;
    /** The user's visible terminal metadata: snapshot, then updates and resets. */
    readonly metadata: Stream.Stream<TerminalMetadataStreamEvent, SqlError>;
    /** The user's visible terminal events: started snapshots, then live events. */
    readonly events: Stream.Stream<TerminalEvent, SqlError>;
  }
>()("@signalbox/cloud/user/UserTerminals") {}

const snapshotJson = Schema.fromJsonString(Schema.toCodecJson(TerminalSessionSnapshot));
const encodeSnapshot = Schema.encodeSync(snapshotJson);
const decodeSnapshotRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      thread_id: Schema.String,
      context_id: SignalboxContextId,
      terminal_id: Schema.String,
      snapshot: snapshotJson,
      has_running_subprocess: Schema.Int,
    }),
  ),
);
const decodeCheckpointRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ thread_id: Schema.String, sequence: NonNegativeInt })),
);

const updateSnapshot = (
  snapshot: TerminalSessionSnapshot,
  delivery: TerminalDelivery,
  patch: Partial<TerminalSessionSnapshot>,
): TerminalSessionSnapshot => ({
  ...snapshot,
  ...patch,
  updatedAt: delivery.updatedAt,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const contexts = yield* UserContexts.UserContexts;
  const published = yield* PubSub.sliding<TerminalChange>(MAX_PENDING_CHANGES);

  yield* sql`CREATE TABLE IF NOT EXISTS cloud_user_terminal_deliveries (
    thread_id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS cloud_user_terminals (
    thread_id TEXT NOT NULL,
    context_id TEXT NOT NULL,
    terminal_id TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    has_running_subprocess INTEGER NOT NULL,
    PRIMARY KEY (thread_id, terminal_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS cloud_user_terminals_context
    ON cloud_user_terminals (context_id, thread_id, terminal_id)`;

  const readTerminal = (threadId: ThreadId, terminalId: string) =>
    Effect.map(
      sql`SELECT thread_id, context_id, terminal_id, snapshot, has_running_subprocess
        FROM cloud_user_terminals WHERE thread_id = ${threadId} AND terminal_id = ${terminalId}`,
      (rows): StoredTerminal | null => {
        const row = decodeSnapshotRows(rows)[0];
        return row === undefined
          ? null
          : {
              threadId: row.thread_id as ThreadId,
              contextId: row.context_id,
              snapshot: row.snapshot,
              hasRunningSubprocess: row.has_running_subprocess !== 0,
            };
      },
    );

  const readState: Effect.Effect<StoredState, SqlError> = sql.withTransaction(
    Effect.gen(function* () {
      const [terminalRows, checkpointRows, contextIds] = yield* Effect.all([
        sql`SELECT thread_id, context_id, terminal_id, snapshot, has_running_subprocess
          FROM cloud_user_terminals ORDER BY thread_id, terminal_id`.pipe(
          Effect.map(decodeSnapshotRows),
        ),
        sql`SELECT thread_id, sequence FROM cloud_user_terminal_deliveries`.pipe(
          Effect.map(decodeCheckpointRows),
        ),
        contexts.contextIds,
      ]);
      return {
        terminals: terminalRows
          .filter((row) => contextIds.includes(row.context_id))
          .map((row) => ({
            threadId: row.thread_id as ThreadId,
            contextId: row.context_id,
            snapshot: row.snapshot,
            hasRunningSubprocess: row.has_running_subprocess !== 0,
          })),
        checkpoints: new Map(
          checkpointRows.map((row) => [row.thread_id as ThreadId, row.sequence] as const),
        ),
      };
    }),
  );

  const checkpoint = (threadId: ThreadId) =>
    Effect.map(
      sql`SELECT thread_id, sequence FROM cloud_user_terminal_deliveries WHERE thread_id = ${threadId}`,
      (rows) => {
        const row = decodeCheckpointRows(rows)[0];
        return row?.sequence ?? 0;
      },
    );

  const saveTerminal = (row: StoredTerminal) =>
    sql`INSERT INTO cloud_user_terminals
        (thread_id, context_id, terminal_id, snapshot, has_running_subprocess)
      VALUES (${row.threadId}, ${row.contextId}, ${row.snapshot.terminalId},
        ${encodeSnapshot(row.snapshot)}, ${row.hasRunningSubprocess ? 1 : 0})
      ON CONFLICT (thread_id, terminal_id) DO UPDATE SET
        context_id = excluded.context_id,
        snapshot = excluded.snapshot,
        has_running_subprocess = excluded.has_running_subprocess`.pipe(Effect.asVoid);

  const record: UserTerminals["Service"]["record"] = (delivery) =>
    Effect.gen(function* () {
      const change = yield* sql.withTransaction(
        Effect.gen(function* () {
          const previous = yield* checkpoint(delivery.threadId);
          if (delivery.sequence <= previous) return null;

          const metadata = new Map<string, TerminalMetadataStreamEvent>();
          for (const event of delivery.events) {
            if (event.threadId !== delivery.threadId) continue;
            if (
              (event.type === "started" || event.type === "restarted") &&
              (event.snapshot.threadId !== delivery.threadId ||
                event.snapshot.terminalId !== event.terminalId)
            ) {
              continue;
            }

            const current = yield* readTerminal(delivery.threadId, event.terminalId);
            if (event.type === "closed") {
              yield* sql`DELETE FROM cloud_user_terminals
                WHERE thread_id = ${delivery.threadId} AND terminal_id = ${event.terminalId}`;
              metadata.set(terminalKey(delivery.threadId, event.terminalId), {
                type: "remove",
                threadId: delivery.threadId,
                terminalId: event.terminalId,
              });
              continue;
            }

            let next: StoredTerminal | null = current;
            switch (event.type) {
              case "started":
              case "restarted": {
                const snapshot = updateSnapshot(event.snapshot, delivery, {
                  threadId: delivery.threadId,
                  terminalId: event.terminalId,
                  // Runner snapshots are authoritative; an empty one clears output on restart.
                  history: terminalHistoryTail(event.snapshot.history),
                  ...(event.sequence === undefined && event.snapshot.sequence === undefined
                    ? {}
                    : { sequence: event.sequence ?? event.snapshot.sequence }),
                });
                next = {
                  threadId: delivery.threadId,
                  contextId: delivery.contextId,
                  snapshot,
                  hasRunningSubprocess: false,
                };
                break;
              }
              case "output":
                if (current !== null) {
                  next = {
                    ...current,
                    contextId: delivery.contextId,
                    snapshot: updateSnapshot(current.snapshot, delivery, {
                      history: terminalHistoryTail(current.snapshot.history + event.data),
                      ...(event.sequence === undefined ? {} : { sequence: event.sequence }),
                    }),
                  };
                }
                break;
              case "cleared":
                if (current !== null) {
                  next = {
                    ...current,
                    contextId: delivery.contextId,
                    snapshot: updateSnapshot(current.snapshot, delivery, {
                      history: "",
                      ...(event.sequence === undefined ? {} : { sequence: event.sequence }),
                    }),
                  };
                }
                break;
              case "exited":
                if (current !== null) {
                  next = {
                    ...current,
                    contextId: delivery.contextId,
                    snapshot: updateSnapshot(current.snapshot, delivery, {
                      status: "exited",
                      pid: null,
                      exitCode: event.exitCode,
                      exitSignal: event.exitSignal,
                      ...(event.sequence === undefined ? {} : { sequence: event.sequence }),
                    }),
                  };
                }
                break;
              case "error":
                if (current !== null) {
                  next = {
                    ...current,
                    contextId: delivery.contextId,
                    snapshot: updateSnapshot(current.snapshot, delivery, {
                      status: "error",
                      pid: null,
                      ...(event.sequence === undefined ? {} : { sequence: event.sequence }),
                    }),
                  };
                }
                break;
              case "activity":
                if (current !== null) {
                  next = {
                    ...current,
                    contextId: delivery.contextId,
                    hasRunningSubprocess: event.hasRunningSubprocess,
                    snapshot: updateSnapshot(current.snapshot, delivery, {
                      label: event.label,
                      ...(event.sequence === undefined ? {} : { sequence: event.sequence }),
                    }),
                  };
                }
                break;
              default:
                next = current;
            }

            if (next === null) continue;
            yield* saveTerminal(next);
            metadata.set(terminalKey(delivery.threadId, event.terminalId), {
              type: "upsert",
              terminal: toSummary(next),
            });
          }

          yield* sql`INSERT INTO cloud_user_terminal_deliveries (thread_id, sequence)
            VALUES (${delivery.threadId}, ${delivery.sequence})
            ON CONFLICT (thread_id) DO UPDATE SET sequence = excluded.sequence`;
          return {
            threadId: delivery.threadId,
            contextId: delivery.contextId,
            sequence: delivery.sequence,
            previousSequence: previous,
            events: delivery.events.filter((event) => event.threadId === delivery.threadId),
            metadata: Array.from(metadata.values()),
          } satisfies TerminalChange;
        }),
      );

      if (change !== null) yield* PubSub.publish(published, change);
    });

  const streams = yield* makeUserTerminalStreams({ readState, published, contexts });
  return UserTerminals.of({ record, ...streams });
});

export const layer = Layer.effect(UserTerminals, make);
