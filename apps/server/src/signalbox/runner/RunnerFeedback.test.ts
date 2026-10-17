import type { FeedbackRequest } from "@signalbox/runner-protocol/FeedbackProtocol";
import {
  OrchestrationV2ProviderThread,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scheduler from "effect/Scheduler";

import { makeRunnerFeedback } from "./RunnerFeedback.ts";

const threadId = ThreadId.make("thread-1");
const thread = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ProviderThread))({
  id: "provider-thread-1",
  driver: "codex",
  providerInstanceId: "codex",
  providerSessionId: "session-1",
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: { driver: "codex", nativeId: "native-1", strength: "strong" },
  nativeConversationHeadRef: null,
  status: "active",
  firstRunOrdinal: 1,
  lastRunOrdinal: 1,
  handoffIds: [],
  forkedFrom: null,
  createdAt: "2026-10-18T00:00:00Z",
  updatedAt: "2026-10-18T00:00:00Z",
});
const request: FeedbackRequest = {
  type: "feedback.upload",
  requestId: "one",
  providerThread: thread,
  reason: "private reason canary",
};

describe("Runner feedback", () => {
  it.effect(
    "claims identical requests once even when scheduling yields during receipt creation",
    () =>
      Effect.forEach([4, 5, 6, 7, 8, 9, 10, 11, 12, 16, 24, 32], (budget) =>
        Effect.gen(function* () {
          let uploads = 0;
          const session = {
            providerSessionId: ProviderSessionId.make("session-1"),
            uploadFeedback: () =>
              Effect.sync(() => {
                uploads++;
                return { feedbackId: "receipt-1" };
              }),
          };
          const feedback = makeRunnerFeedback(threadId, () => session);
          feedback.remember(session, thread);
          const results = yield* Effect.all(
            Array.from({ length: 16 }, () => feedback.upload(request)),
            { concurrency: "unbounded" },
          );
          expect(uploads).toBe(1);
          expect(results).toEqual(
            Array.from({ length: 16 }, () => ({ _tag: "uploaded", feedbackId: "receipt-1" })),
          );
        }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, budget)),
      ),
  );
  it.effect("uploads only on request and takes concurrent duplicates once", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const calls: Array<unknown> = [];
      const session = {
        providerSessionId: ProviderSessionId.make("session-1"),
        uploadFeedback: (input: unknown) =>
          Effect.gen(function* () {
            calls.push(input);
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(finish);
            return { feedbackId: "receipt-1" };
          }),
      };
      const feedback = makeRunnerFeedback(threadId, () => session);
      feedback.remember(session, thread);
      expect(calls).toEqual([]);
      const first = yield* feedback.upload(request).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const second = yield* feedback.upload(request).pipe(Effect.forkChild);
      yield* Deferred.succeed(finish, undefined);
      expect(yield* Fiber.join(first)).toEqual({ _tag: "uploaded", feedbackId: "receipt-1" });
      expect(yield* Fiber.join(second)).toEqual({ _tag: "uploaded", feedbackId: "receipt-1" });
      expect(yield* feedback.upload(request)).toEqual({
        _tag: "uploaded",
        feedbackId: "receipt-1",
      });
      expect(calls).toEqual([{ providerThread: thread, reason: "private reason canary" }]);
    }),
  );

  it.effect("refuses a different native session, provider thread, or app thread", () =>
    Effect.gen(function* () {
      const session = {
        providerSessionId: ProviderSessionId.make("session-1"),
        uploadFeedback: () => Effect.die("must not send"),
      };
      const feedback = makeRunnerFeedback(threadId, () => session);
      feedback.remember(session, thread);
      const mismatches = [
        { ...thread, providerSessionId: ProviderSessionId.make("another-session") },
        { ...thread, appThreadId: ThreadId.make("another-thread") },
        { ...thread, id: ProviderThreadId.make("another-provider-thread") },
        { ...thread, nativeThreadRef: { ...thread.nativeThreadRef!, nativeId: "another-native" } },
        { ...thread, nativeThreadRef: null },
      ];
      for (const [index, providerThread] of mismatches.entries()) {
        expect(
          yield* feedback.upload({ ...request, requestId: `mismatch-${index}`, providerThread }),
        ).toEqual({ _tag: "failed", failure: "session_unavailable" });
      }
    }),
  );

  it.effect("requires a loaded native session after a machine or harness replacement", () =>
    Effect.gen(function* () {
      const session = {
        providerSessionId: ProviderSessionId.make("session-1"),
        uploadFeedback: () => Effect.die("must not send"),
      };
      const fresh = makeRunnerFeedback(threadId, () => session);
      expect(yield* fresh.upload(request)).toEqual({
        _tag: "failed",
        failure: "session_unavailable",
      });
      const replaced = makeRunnerFeedback(threadId, () => ({ ...session }));
      replaced.remember(session, thread);
      expect(yield* replaced.upload(request)).toEqual({
        _tag: "failed",
        failure: "session_unavailable",
      });
    }),
  );

  it.effect("returns typed unsupported for an adapter without uploadFeedback", () =>
    Effect.gen(function* () {
      const session = { providerSessionId: ProviderSessionId.make("session-1") };
      const feedback = makeRunnerFeedback(threadId, () => session);
      feedback.remember(session, thread);
      expect(yield* feedback.upload(request)).toEqual({ _tag: "failed", failure: "unsupported" });
    }),
  );

  it.effect("keeps adapter failures and uploaded content off the wire", () =>
    Effect.gen(function* () {
      const session = {
        providerSessionId: ProviderSessionId.make("session-1"),
        uploadFeedback: () => Effect.die("private reason canary"),
      };
      const feedback = makeRunnerFeedback(threadId, () => session);
      feedback.remember(session, thread);
      expect(yield* feedback.upload(request)).toEqual({ _tag: "failed", failure: "upload_failed" });
    }),
  );
});
