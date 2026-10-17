import { CommandId } from "@t3tools/contracts";
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
  return yield* Effect.forEach(streams, (stream) =>
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
            throw new Error("Recovery drill session evidence limit exceeded.");
          }
          hashes.push(yield* digest(row));
          offset += 1;
        }
      }
      return { stream: stream.stream, count: stream.count, hashes };
    }),
  );
});

/** A coherent pre-fault boundary. Tokens, message bodies and native transcript rows stay private. */
export const recoveryEvidence = (userId: string, commandIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    if (!(yield* Effect.orDie(store.initialized))) return null;
    const engine = yield* ThreadEngine;
    const sessions = yield* SessionRows;
    return yield* engine.apply((projection) =>
      Effect.gen(function* () {
        const owner = yield* Effect.orDie(store.owner);
        if (
          projection === null ||
          owner?.userId !== userId ||
          !projection.thread.title.startsWith("recovery-drill/")
        ) {
          return { events: [], result: null };
        }
        const events = yield* Effect.orDie(store.events(0, MAX_EVENTS + 1));
        if (events.length > MAX_EVENTS) throw new Error("Recovery drill event limit exceeded.");
        const { token: _token, ...lease } = yield* Effect.orDie(store.machine);
        const machine = yield* Effect.orDie(store.machineRecord);
        const receipts = yield* Effect.forEach(commandIds, (id) =>
          Effect.map(Effect.orDie(store.receipt(CommandId.make(id))), (receipt) => ({
            id,
            receipt,
          })),
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
          events: [],
          result: {
            threadId: projection.thread.id,
            sequence: events.at(-1)?.sequence ?? 0,
            activeRunId: activeRun(projection)?.id ?? null,
            lease,
            machine,
            receipts,
            events: eventHashes,
            sessions: yield* sessionEvidence.pipe(Effect.provideService(SessionRows, sessions)),
            runs: projection.runs.map((run) => ({
              id: run.id,
              status: run.status,
              restartContinuationOfRunId: run.restartContinuationOfRunId ?? null,
            })),
            reasoning,
          },
        };
      }),
    );
  });

export type RecoveryEvidence = NonNullable<Effect.Success<ReturnType<typeof recoveryEvidence>>>;
