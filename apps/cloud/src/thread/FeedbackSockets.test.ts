import type { FeedbackRequest } from "@signalbox/runner-protocol/FeedbackProtocol";
import { OrchestrationV2ProviderThread, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { FeedbackSockets } from "./FeedbackSockets.ts";
import { fakeSocket } from "./runnerTesting.ts";

const threadId = ThreadId.make("thread-1");
const providerThread = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ProviderThread))({
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
const socketsFor = (sockets: Array<WebSocket>) =>
  new FeedbackSockets({ getWebSockets: () => sockets } as unknown as DurableObjectState);

describe("feedback sockets", () => {
  it.effect("sends only to the leased capable connection and accepts only its answer", () =>
    Effect.gen(function* () {
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
      const sockets = socketsFor([wrong.socket, right.socket]);
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
  );

  it.effect("reports an unconfirmed upload without resending after the deadline", () =>
    Effect.gen(function* () {
      const socket = fakeSocket();
      socket.socket.serializeAttachment({ generation: 1, connection: 1, feedback: true });
      const sockets = socketsFor([socket.socket]);
      const waiting = yield* sockets
        .upload(1, 1, { type: "feedback.upload", requestId: "timeout", providerThread })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      expect(yield* Fiber.join(waiting)).toEqual({ _tag: "failed", failure: "outcome_unknown" });
      expect(socket.sent).toHaveLength(1);
    }),
  );
});
