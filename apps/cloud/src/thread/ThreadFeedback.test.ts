import type { FeedbackRequest } from "@signalbox/runner-protocol/FeedbackProtocol";
import { ProviderDriverKind, ProviderInstanceId, ProviderSessionId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadFeedback from "./ThreadFeedback.ts";
import * as ThreadStore from "./ThreadStore.ts";
import { FeedbackSockets } from "./runner/FeedbackSockets.ts";
import {
  connect,
  fakeSocket,
  freshDatabase,
  hostFor,
  launch,
  liveTurn,
  owner,
  personal,
  threadId,
  turnReport,
  withObject,
} from "./runnerTesting.ts";

const codex = { instanceId: ProviderInstanceId.make("codex_hub"), model: "gpt-6.1" };
const driver = ProviderDriverKind.make("codex");

const startCodex = (
  engine: Parameters<Parameters<typeof withObject>[1]>[0],
  runner: Parameters<Parameters<typeof withObject>[1]>[1],
) =>
  Effect.gen(function* () {
    yield* launch(engine, "launch", personal, { modelSelection: codex });
    const machine = yield* connect(runner);
    const turn = yield* liveTurn(runner);
    const original = turnReport(turn.runId, turn.runOrdinal, turn.providerThread).started;
    const providerThread = {
      ...turn.providerThread,
      providerSessionId: ProviderSessionId.make("codex-session"),
      nativeThreadRef: { driver, nativeId: "native-codex", strength: "strong" as const },
    };
    yield* runner.batch({
      generation: machine.generation,
      sequence: 1,
      items: [
        {
          ...original,
          providerThread,
          providerSession: {
            ...original.providerSession,
            id: ProviderSessionId.make("codex-session"),
            driver,
            providerInstanceId: codex.instanceId,
          },
        },
      ],
    });
    return { machine, providerThread };
  });

describe("cloud provider feedback", () => {
  it.effect("uses the active native session once and replays its safe receipt after eviction", () =>
    Effect.gen(function* () {
      const filename = freshDatabase();
      const requests: Array<FeedbackRequest> = [];
      const feedback: ThreadFeedback.FeedbackTransport["Service"] = {
        upload: (generation, connection, request) =>
          Effect.sync(() => {
            expect([generation, connection]).toEqual([1, 1]);
            requests.push(request);
            return { _tag: "uploaded", feedbackId: "feedback-receipt" };
          }),
      };
      yield* withObject(
        filename,
        (engine, runner, context) =>
          Effect.gen(function* () {
            const { providerThread } = yield* startCodex(engine, runner);
            const service = Context.get(context, ThreadFeedback.ThreadFeedback);
            expect(
              yield* service.upload(owner, {
                threadId,
                requestId: "one",
                reason: "private feedback canary",
              }),
            ).toEqual({ _tag: "uploaded", feedbackId: "feedback-receipt" });
            expect(requests[0]).toMatchObject({
              providerThread: {
                id: providerThread.id,
                providerInstanceId: "codex",
                providerSessionId: "codex-session",
                nativeThreadRef: { nativeId: "native-codex" },
              },
              reason: "private feedback canary",
            });
            const sql = Context.get(context, SqlClient.SqlClient);
            const receipts = yield* sql`SELECT * FROM provider_feedback_receipts`;
            expect(JSON.stringify(receipts)).not.toContain("private feedback canary");
            expect(receipts).toHaveLength(1);
            expect(
              (yield* service
                .upload({ ...owner, userId: "someone-else" }, { threadId, requestId: "one" })
                .pipe(Effect.flip))._tag,
            ).toBe("ThreadNotFoundError");
          }),
        { feedback },
      );
      yield* withObject(
        filename,
        (_engine, _runner, context) =>
          Effect.gen(function* () {
            const service = Context.get(context, ThreadFeedback.ThreadFeedback);
            expect(yield* service.upload(owner, { threadId, requestId: "one" })).toEqual({
              _tag: "uploaded",
              feedbackId: "feedback-receipt",
            });
          }),
        { feedback },
      );
      expect(requests).toHaveLength(1);
    }),
  );

  it.effect("refuses other people and unknown threads before any receipt or upload", () =>
    withObject(freshDatabase(), (engine, _runner, context) =>
      Effect.gen(function* () {
        const service = Context.get(context, ThreadFeedback.ThreadFeedback);
        expect((yield* service.upload(owner, { threadId }).pipe(Effect.flip))._tag).toBe(
          "ThreadNotFoundError",
        );
        yield* launch(engine);
        expect(
          (yield* service.upload({ ...owner, userId: "other" }, { threadId }).pipe(Effect.flip))
            ._tag,
        ).toBe("ThreadNotFoundError");
        const sql = Context.get(context, SqlClient.SqlClient);
        expect(
          yield* sql`SELECT name FROM sqlite_master WHERE name = 'provider_feedback_receipts'`,
        ).toEqual([]);
      }),
    ),
  );

  it.effect("returns unsupported for other harnesses without sending anything", () =>
    withObject(
      freshDatabase(),
      (engine, _runner, context) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const service = Context.get(context, ThreadFeedback.ThreadFeedback);
          expect(yield* service.upload(owner, { threadId })).toEqual({
            _tag: "failed",
            failure: "unsupported",
          });
        }),
      { feedback: { upload: () => Effect.die("must not send") } },
    ),
  );

  it.effect(
    "explains a missing native session and a disconnected machine without starting one",
    () =>
      withObject(
        freshDatabase(),
        (engine, runner, context) =>
          Effect.gen(function* () {
            yield* launch(engine, "launch", personal, { modelSelection: codex });
            const service = Context.get(context, ThreadFeedback.ThreadFeedback);
            expect(yield* service.upload(owner, { threadId })).toEqual({
              _tag: "failed",
              failure: "session_unavailable",
            });
            yield* startCodex(engine, runner);
            const store = Context.get(context, ThreadStore.ThreadStore);
            yield* store.saveMachine({ ...(yield* store.machine), disconnectedAt: 1 });
            expect(yield* service.upload(owner, { threadId })).toEqual({
              _tag: "failed",
              failure: "runner_unavailable",
            });
          }),
        { feedback: { upload: () => Effect.die("must not send") } },
      ),
  );

  it.effect("never replays an upload whose acknowledgement was lost", () =>
    Effect.gen(function* () {
      const filename = freshDatabase();
      let sends = 0;
      const sent = yield* Deferred.make<void>();
      const feedback: ThreadFeedback.FeedbackTransport["Service"] = {
        upload: () =>
          Effect.gen(function* () {
            sends++;
            yield* Deferred.succeed(sent, undefined);
            return yield* Effect.never;
          }),
      };
      yield* withObject(
        filename,
        (engine, runner, context) =>
          Effect.gen(function* () {
            yield* startCodex(engine, runner);
            const service = Context.get(context, ThreadFeedback.ThreadFeedback);
            const pending = yield* service
              .upload(owner, { threadId, requestId: "lost" })
              .pipe(Effect.forkChild);
            yield* Deferred.await(sent);
            yield* Fiber.interrupt(pending);
          }),
        { feedback },
      );
      yield* withObject(
        filename,
        (_engine, _runner, context) =>
          Context.get(context, ThreadFeedback.ThreadFeedback)
            .upload(owner, { threadId, requestId: "lost" })
            .pipe(
              Effect.tap((outcome) =>
                Effect.sync(() =>
                  expect(outcome).toEqual({ _tag: "failed", failure: "outcome_unknown" }),
                ),
              ),
            ),
        { feedback },
      );
      expect(sends).toBe(1);
    }),
  );

  it.effect("sends only to the leased capable connection and accepts only its answer", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { providerThread } = yield* startCodex(engine, runner);
        const right = fakeSocket();
        const wrong = fakeSocket();
        const sent = yield* Deferred.make<void>();
        const originalSend = right.socket.send.bind(right.socket);
        right.socket.send = (data) => {
          if (typeof data !== "string") throw new Error("expected a JSON frame");
          originalSend(data);
          Deferred.doneUnsafe(sent, Effect.void);
        };
        right.socket.serializeAttachment({ generation: 1, connection: 1, feedback: true });
        wrong.socket.serializeAttachment({ generation: 1, connection: 2, feedback: true });
        const host = yield* hostFor(runner, [wrong.socket, right.socket]);
        const sockets = new FeedbackSockets(host.ctx);
        const request: FeedbackRequest = {
          type: "feedback.upload",
          requestId: "socket",
          providerThread,
        };
        const waiting = yield* sockets.upload(1, 1, request).pipe(Effect.forkChild);
        yield* Deferred.await(sent);
        expect(right.sent).toEqual([request]);
        expect(wrong.sent).toEqual([]);
        sockets.receive(wrong.socket, {
          type: "feedback.result",
          requestId: "socket",
          outcome: { _tag: "uploaded", feedbackId: "wrong" },
        });
        sockets.receive(right.socket, {
          type: "feedback.result",
          requestId: "socket",
          outcome: { _tag: "uploaded", feedbackId: "right" },
        });
        expect(yield* Fiber.join(waiting)).toEqual({ _tag: "uploaded", feedbackId: "right" });
        expect(yield* sockets.upload(2, 1, request)).toEqual({
          _tag: "failed",
          failure: "runner_unavailable",
        });
        right.socket.serializeAttachment({ generation: 1, connection: 1 });
        expect(yield* sockets.upload(1, 1, request)).toEqual({
          _tag: "failed",
          failure: "runner_unavailable",
        });
      }),
    ),
  );

  it.effect("reports an unconfirmed upload without resending after the deadline", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { providerThread } = yield* startCodex(engine, runner);
        const socket = fakeSocket();
        socket.socket.serializeAttachment({ generation: 1, connection: 1, feedback: true });
        const host = yield* hostFor(runner, [socket.socket]);
        const sockets = new FeedbackSockets(host.ctx);
        const waiting = yield* sockets
          .upload(1, 1, { type: "feedback.upload", requestId: "timeout", providerThread })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        expect(yield* Fiber.join(waiting)).toEqual({ _tag: "failed", failure: "outcome_unknown" });
        expect(socket.sent).toHaveLength(1);
      }),
    ),
  );
});
