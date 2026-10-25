import { CommandId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { SessionRows } from "./session/SessionRows.ts";
import { ThreadEngine } from "./ThreadEngine.ts";
import { ThreadStore } from "./ThreadStore.ts";
import { activeRun } from "./runLifecycle.ts";

const MAX_EVENTS = 4_096;
const MAX_SESSION_ROWS = 4_096;
const MAX_SESSION_CHARS = 8_000_000;

const digest = (text: string) =>
  Effect.promise(async () => {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  });

/** Hashes verbatim native rows, including opaque reasoning, without exposing their bodies. */
const sessionEvidence = Effect.gen(function* () {
  const sessions = yield* SessionRows;
  const streams = yield* Effect.orDie(sessions.streams(""));
  let chars = 0;
  let rows = 0;
  const results = yield* Effect.forEach(streams, (stream) =>
    Effect.gen(function* () {
      const hashes: Array<string> = [];
      let offset = 0;
      while (offset < stream.count) {
        const page = yield* Effect.orDie(sessions.rows(stream.stream, offset));
        if (page.rows.length === 0) throw new Error("Session evidence has a row gap.");
        for (const row of page.rows.slice(0, stream.count - offset)) {
          chars += row.length;
          rows += 1;
          if (chars > MAX_SESSION_CHARS || rows > MAX_SESSION_ROWS) {
            return null;
          }
          hashes.push(yield* digest(row));
          offset += 1;
        }
      }
      return { stream: stream.stream, count: stream.count, hashes };
    }),
  );
  return results.some((stream) => stream === null)
    ? null
    : results.filter((stream) => stream !== null);
});

/** Runs only while its caller owns engine serialization. */
const inspectRecovery = (
  projection: OrchestrationV2ThreadProjection | null,
  userId: string,
  commandIds: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    if (!(yield* Effect.orDie(store.initialized))) return null;
    const owner = yield* Effect.orDie(store.owner);
    if (
      projection === null ||
      owner?.userId !== userId ||
      !projection.thread.title.startsWith("recovery-drill/")
    )
      return null;
    const events = yield* Effect.orDie(store.events(0, MAX_EVENTS + 1));
    if (events.length > MAX_EVENTS) return { error: "evidence_limit" as const };
    const sessionRows = yield* sessionEvidence;
    if (sessionRows === null) return { error: "evidence_limit" as const };
    const { token: _token, ...lease } = yield* Effect.orDie(store.machine);
    const machine = yield* Effect.orDie(store.machineRecord);
    const receipts = yield* Effect.forEach(commandIds, (id) =>
      Effect.map(Effect.orDie(store.receipt(CommandId.make(id))), (receipt) => ({ id, receipt })),
    );
    const eventHashes = yield* Effect.forEach(events, ({ sequence, event }) =>
      Effect.map(digest(JSON.stringify(event)), (hash) => ({ sequence, id: event.id, hash })),
    );
    const reasoning = yield* Effect.forEach(
      projection.turnItems.filter((item) => item.type === "reasoning"),
      (item) =>
        Effect.map(digest(item.text), (hash) => ({
          id: item.id,
          runId: item.runId,
          status: item.status,
          hash,
        })),
    );
    return {
      threadId: projection.thread.id,
      sequence: events.at(-1)?.sequence ?? 0,
      activeRunId: activeRun(projection)?.id ?? null,
      lease,
      machine,
      receipts,
      events: eventHashes,
      sessions: sessionRows,
      runs: projection.runs.map((run) => ({
        id: run.id,
        status: run.status,
        restartContinuationOfRunId: run.restartContinuationOfRunId ?? null,
      })),
      reasoning,
    };
  });

export type RecoveryInspection = Effect.Success<ReturnType<typeof inspectRecovery>>;
export type RecoveryEvidence = Exclude<NonNullable<RecoveryInspection>, { readonly error: string }>;

/** Acquire engine serialization before the platform input gate, never while holding it. */
export const withRecoveryInspection = <A>(
  work: (
    inspect: (
      userId: string,
      commandIds: ReadonlyArray<string>,
    ) => Effect.Effect<RecoveryInspection>,
  ) => Effect.Effect<A>,
) =>
  Effect.gen(function* () {
    const engine = yield* ThreadEngine;
    const store = yield* ThreadStore;
    const sessions = yield* SessionRows;
    return yield* engine.apply((projection) =>
      work((userId, commandIds) =>
        inspectRecovery(projection, userId, commandIds).pipe(
          Effect.provideService(ThreadStore, store),
          Effect.provideService(SessionRows, sessions),
        ),
      ).pipe(Effect.map((result) => ({ events: [], result }))),
    );
  });

/** Tokens, message bodies and native transcript rows stay private. */
export const recoveryEvidence = (userId: string, commandIds: ReadonlyArray<string>) =>
  withRecoveryInspection((inspect) => inspect(userId, commandIds));
