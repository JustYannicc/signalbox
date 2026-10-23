import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HarnessError } from "../Harness.ts";
import type { HarnessContinuation } from "../HarnessContinuations.ts";
import { createContinuationJournal } from "../HarnessContinuationJournal.ts";
import { hostSqlite } from "./hostSqlite.ts";

const request: HarnessContinuation = {
  threadId: ThreadId.make("journal-thread"),
  sourceRunId: RunId.make("journal-source"),
  providerThreadId: ProviderThreadId.make("journal-provider"),
  driver: ProviderDriverKind.make("claudeAgent"),
  messageId: MessageId.make("journal-wake"),
  detail: "Background work finished.",
  delivery: "adapter_buffered",
};
const database = Effect.acquireRelease(Effect.sync(hostSqlite), (db) =>
  Effect.sync(() => db.dispose()),
);
const rows = (handle: ReturnType<ReturnType<typeof hostSqlite>["open"]>) =>
  handle.rows("SELECT message_id, request_json, published FROM harness_continuation_requests");

describe("Harness continuation journal", () => {
  it.effect(
    "commits before publication and avoids duplicate publication after reconstruction",
    () =>
      Effect.gen(function* () {
        const db = yield* database;
        const handle = db.open();
        let calls = 0;
        const publisher = {
          publish: (value: HarnessContinuation) =>
            Effect.sync(() => {
              calls++;
              expect(value).toEqual(request);
              expect(rows(handle)).toMatchObject([{ message_id: request.messageId, published: 0 }]);
            }),
        };
        const journal = yield* createContinuationJournal(
          handle.storage,
          publisher,
          new AbortController().signal,
        );
        yield* journal.publish(request);
        expect(rows(handle)).toMatchObject([{ message_id: request.messageId, published: 1 }]);
        handle.close();
        const reopened = db.open();
        const recovered = yield* createContinuationJournal(
          reopened.storage,
          publisher,
          new AbortController().signal,
        );
        yield* recovered.replay;
        yield* recovered.publish(request);
        expect(calls).toBe(1);
      }),
  );

  it.effect("replays an unacknowledged request after publication fails", () =>
    Effect.gen(function* () {
      const db = yield* database;
      const handle = db.open();
      const failure = new HarnessError({ operation: "events", message: "Disconnected publisher" });
      const journal = yield* createContinuationJournal(
        handle.storage,
        { publish: () => Effect.fail(failure) },
        new AbortController().signal,
      );
      expect(yield* journal.publish(request).pipe(Effect.flip)).toBe(failure);
      expect(rows(handle)).toMatchObject([{ published: 0 }]);
      handle.close();
      const reopened = db.open();
      const published: HarnessContinuation[] = [];
      const recovered = yield* createContinuationJournal(
        reopened.storage,
        {
          publish: (value) =>
            Effect.sync(() => {
              published.push(value);
            }),
        },
        new AbortController().signal,
      );
      yield* recovered.replay;
      expect(published).toEqual([request]);
      expect(rows(reopened)).toMatchObject([{ published: 1 }]);
    }),
  );

  it.effect("does not publish a failed journal write or a conflicting identity", () =>
    Effect.gen(function* () {
      const db = yield* database;
      const handle = db.open();
      let calls = 0;
      const journal = yield* createContinuationJournal(
        handle.storage,
        {
          publish: () =>
            Effect.sync(() => {
              calls++;
            }),
        },
        new AbortController().signal,
      );
      handle.failOnce((query) => query.startsWith("INSERT INTO harness_continuation_requests"));
      expect(yield* journal.publish(request).pipe(Effect.flip)).toMatchObject({
        operation: "journal",
      });
      expect(calls).toBe(0);
      expect(rows(handle)).toEqual([]);
      yield* journal.publish(request);
      expect(
        yield* journal.publish({ ...request, detail: "Conflicting wake" }).pipe(Effect.flip),
      ).toMatchObject({ operation: "journal" });
      expect(calls).toBe(1);
    }),
  );

  it.effect("keeps a failed publication receipt pending for idempotent replay", () =>
    Effect.gen(function* () {
      const db = yield* database;
      const handle = db.open();
      let calls = 0;
      const journal = yield* createContinuationJournal(
        handle.storage,
        {
          publish: () =>
            Effect.sync(() => {
              calls++;
            }),
        },
        new AbortController().signal,
      );
      handle.failOnce((query) => query.startsWith("UPDATE harness_continuation_requests"));
      expect(yield* journal.publish(request).pipe(Effect.flip)).toMatchObject({
        operation: "journal",
      });
      expect(rows(handle)).toMatchObject([{ published: 0 }]);
      yield* journal.replay;
      expect(calls).toBe(2);
      expect(rows(handle)).toMatchObject([{ published: 1 }]);
    }),
  );

  it.effect("ends publication with its owner and leaves an in-flight receipt pending", () =>
    Effect.gen(function* () {
      const db = yield* database;
      const handle = db.open();
      const owner = new AbortController();
      let calls = 0;
      const journal = yield* createContinuationJournal(
        handle.storage,
        {
          publish: () =>
            Effect.sync(() => {
              calls++;
              owner.abort();
            }),
        },
        owner.signal,
      );
      expect(yield* journal.publish(request).pipe(Effect.flip)).toMatchObject({
        operation: "journal",
      });
      expect(rows(handle)).toMatchObject([{ published: 0 }]);
      expect(yield* journal.publish(request).pipe(Effect.flip)).toMatchObject({
        operation: "journal",
      });
      expect(calls).toBe(1);
    }),
  );
});
