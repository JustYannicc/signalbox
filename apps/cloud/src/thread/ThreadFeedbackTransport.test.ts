import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { FeedbackSockets } from "./FeedbackSockets.ts";
import * as ThreadFeedback from "./ThreadFeedback.ts";
import * as ThreadStore from "./ThreadStore.ts";
import { fakeSocket, freshDatabase, owner, threadId, withObject } from "./runnerTesting.ts";
import { startCodex } from "./tests/feedbackTesting.ts";

const socketsFor = (sockets: Array<WebSocket>) =>
  new FeedbackSockets({ getWebSockets: () => sockets } as unknown as DurableObjectState);

describe("feedback dispatch receipts", () => {
  it.effect(
    "releases only a locally unsent claim and uploads once after the same ID recovers",
    () =>
      Effect.gen(function* () {
        const socket = fakeSocket();
        const feedback = socketsFor([socket.socket]);
        yield* withObject(
          freshDatabase(),
          (engine, runner, context) =>
            Effect.gen(function* () {
              yield* startCodex(engine, runner);
              const store = Context.get(context, ThreadStore.ThreadStore);
              expect(yield* store.machine).toMatchObject({
                status: "connected",
                connection: 1,
                disconnectedAt: null,
              });
              const service = Context.get(context, ThreadFeedback.ThreadFeedback);
              const sql = Context.get(context, SqlClient.SqlClient);
              const input = { threadId, requestId: "upgrade" };
              socket.socket.serializeAttachment({ generation: 1, connection: 1, feedback: false });
              expect(yield* service.upload(owner, input)).toEqual({
                _tag: "failed",
                failure: "runner_unavailable",
              });
              expect(socket.sent).toEqual([]);
              expect(yield* sql`SELECT * FROM provider_feedback_receipts`).toEqual([]);
              socket.socket.serializeAttachment({ generation: 1, connection: 1, feedback: true });
              const sent = yield* Deferred.make<void>();
              const send = socket.socket.send.bind(socket.socket);
              socket.socket.send = (data) => {
                if (typeof data !== "string") throw new Error("expected a JSON frame");
                send(data);
                Deferred.doneUnsafe(sent, Effect.void);
              };
              const uploading = yield* service.upload(owner, input).pipe(Effect.forkChild);
              yield* Deferred.await(sent);
              const outcome = { _tag: "uploaded", feedbackId: "after-upgrade" } as const;
              feedback.receive(socket.socket, {
                type: "feedback.result",
                requestId: input.requestId,
                outcome,
              });
              expect(yield* Fiber.join(uploading)).toEqual(outcome);
              socket.socket.serializeAttachment(null);
              expect(yield* service.upload(owner, input)).toEqual(outcome);
              expect(socket.sent).toHaveLength(1);
              expect(yield* sql`SELECT * FROM provider_feedback_receipts`).toHaveLength(1);
            }),
          { feedback },
        );
      }),
  );

  it.effect(
    "retains runner-reported failures and ambiguous sends across retries and eviction",
    () =>
      Effect.forEach(["runner_failure", "send_throw", "timeout"] as const, (scenario) =>
        Effect.gen(function* () {
          const filename = freshDatabase();
          const socket = fakeSocket();
          const feedback = socketsFor([socket.socket]);
          const sent = yield* Deferred.make<void>();
          const send = socket.socket.send.bind(socket.socket);
          socket.socket.serializeAttachment({ generation: 1, connection: 1, feedback: true });
          let attempts = 0;
          socket.socket.send = (data) => {
            attempts++;
            if (typeof data !== "string") throw new Error("expected a JSON frame");
            send(data);
            Deferred.doneUnsafe(sent, Effect.void);
            if (scenario === "send_throw")
              throw new Error("socket send failed after accepting the frame");
          };
          const input = { threadId, requestId: scenario };
          const expected = {
            _tag: "failed",
            failure: scenario === "runner_failure" ? "runner_unavailable" : "outcome_unknown",
          } as const;
          yield* withObject(
            filename,
            (engine, runner, context) =>
              Effect.gen(function* () {
                yield* startCodex(engine, runner);
                const service = Context.get(context, ThreadFeedback.ThreadFeedback);
                const uploading = yield* service.upload(owner, input).pipe(Effect.forkChild);
                yield* Deferred.await(sent);
                if (scenario === "runner_failure") {
                  feedback.receive(socket.socket, {
                    type: "feedback.result",
                    requestId: input.requestId,
                    outcome: { _tag: "failed", failure: "runner_unavailable" },
                  });
                } else if (scenario === "timeout") {
                  yield* TestClock.adjust("30 seconds");
                }
                expect(yield* Fiber.join(uploading)).toEqual(expected);
                const sql = Context.get(context, SqlClient.SqlClient);
                expect(yield* sql`SELECT * FROM provider_feedback_receipts`).toHaveLength(1);
                socket.socket.serializeAttachment(null);
                expect(yield* service.upload(owner, input)).toEqual(expected);
                expect(attempts).toBe(1);
              }),
            { feedback },
          );
          yield* withObject(
            filename,
            (_engine, _runner, context) =>
              Effect.gen(function* () {
                const service = Context.get(context, ThreadFeedback.ThreadFeedback);
                expect(
                  (yield* service.upload({ ...owner, userId: "other" }, input).pipe(Effect.flip))
                    ._tag,
                ).toBe("ThreadNotFoundError");
                expect(yield* service.upload(owner, input)).toEqual(expected);
              }),
            {
              feedback: {
                upload: () => Effect.die("a recorded outcome must never dispatch again"),
              },
            },
          );
          expect(attempts).toBe(1);
        }),
      ),
  );
});
