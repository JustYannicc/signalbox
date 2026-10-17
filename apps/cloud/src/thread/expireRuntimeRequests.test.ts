import {
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  ProviderTurnId,
  RuntimeRequestId,
  TurnItemId,
} from "@t3tools/contracts";
import { mirrorNativeAskEvents } from "@t3tools/shared/signalboxNativeAsks";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { expireRuntimeRequests } from "./expireRuntimeRequests.ts";
import { applyEvents } from "./threadProjection.ts";
import { unstampedEventId } from "./threadEvents.ts";
import {
  connect,
  freshDatabase,
  launch,
  liveTurn,
  snapshot,
  turnReport,
  withObject,
} from "./runnerTestKit.ts";

const fixture = () =>
  withObject(freshDatabase(), (engine, runner) =>
    Effect.gen(function* () {
      yield* launch(engine);
      const machine = yield* connect(runner);
      const turn = yield* liveTurn(runner);
      const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
      yield* runner.batch({ generation: machine.generation, sequence: 1, items: [report.started] });
      const { projection } = yield* snapshot(engine);
      const run = projection.runs[0]!;
      const node = projection.nodes[0]!;
      const session = projection.providerSessions[0]!;
      const now = DateTime.makeUnsafe(1_000);
      const base = { id: unstampedEventId, threadId: projection.thread.id, occurredAt: now };
      const request: OrchestrationV2RuntimeRequest = {
        id: RuntimeRequestId.make("new-request"),
        nodeId: NodeId.make("new-question-node"),
        providerTurnId: ProviderTurnId.make("new-provider-turn"),
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "live", providerSessionId: session.id },
        createdAt: now,
        resolvedAt: null,
      };
      const item: OrchestrationV2TurnItem = {
        id: TurnItemId.make("new-question-item"),
        threadId: projection.thread.id,
        runId: run.id,
        nodeId: request.nodeId,
        providerThreadId: run.providerThreadId,
        providerTurnId: request.providerTurnId,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 2,
        status: "waiting",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "user_input_request",
        requestId: request.id,
        questions: [
          { id: "city", header: "City", question: "Which city?", options: [] },
          {
            id: "token",
            header: "Secret",
            question: "Private token",
            options: [],
            native: { isSecret: true },
          },
        ],
      };
      const requested: OrchestrationV2DomainEvent = {
        ...base,
        type: "runtime-request.updated",
        payload: request,
      };
      const linked: OrchestrationV2DomainEvent = {
        ...base,
        type: "node.updated",
        payload: {
          ...node,
          id: request.nodeId,
          kind: "user_input_request",
          runtimeRequestId: request.id,
        },
      };
      const asked: OrchestrationV2DomainEvent = {
        ...base,
        type: "turn-item.updated",
        payload: item,
      };
      return { projection, run, node, session, now, base, request, item, requested, linked, asked };
    }),
  );

const requestAfter = (
  state: Effect.Success<ReturnType<typeof fixture>>,
  events: readonly OrchestrationV2DomainEvent[],
) =>
  applyEvents(state.projection, events)?.runtimeRequests.find(
    (request) => request.id === state.request.id,
  );

describe("expireRuntimeRequests", () => {
  it.effect.each(["node", "item"] as const)(
    "expires a callback linked by a new %s in the same terminal-run batch",
    (link) =>
      Effect.gen(function* () {
        const state = yield* fixture();
        const events: OrchestrationV2DomainEvent[] = [
          state.requested,
          link === "node" ? state.linked : state.asked,
          {
            ...state.base,
            type: "run.updated",
            payload: { ...state.run, status: "completed", completedAt: state.now },
          },
        ];
        expect(requestAfter(state, expireRuntimeRequests(state.projection, events))).toMatchObject({
          status: "expired",
          resolvedAt: state.now,
        });
      }),
  );

  it.effect.each(["completed", "failed", "interrupted", "cancelled", "rolled_back"] as const)(
    "expires the callback when its run is %s",
    (status) =>
      Effect.gen(function* () {
        const state = yield* fixture();
        const events: OrchestrationV2DomainEvent[] = [
          state.requested,
          state.linked,
          state.asked,
          {
            ...state.base,
            type: "run.updated",
            payload: { ...state.run, status, completedAt: state.now },
          },
        ];
        const expired = expireRuntimeRequests(state.projection, events);
        expect(requestAfter(state, expired)?.status).toBe("expired");
        expect(expired.at(-1)).toMatchObject({
          type: "runtime-request.updated",
          runId: state.run.id,
        });
        const mirrored = applyEvents(
          state.projection,
          mirrorNativeAskEvents(state.projection, expired),
        );
        expect(mirrored?.thread.asks?.[0]).toMatchObject({
          status: "pending",
          source: { kind: "native", requestId: state.request.id },
        });
        expect(mirrored?.thread.asks?.[0]?.questions.map((question) => question.id)).toEqual([
          "city",
        ]);
        expect(JSON.stringify(mirrored?.thread.asks)).not.toContain("Private token");
      }),
  );

  it.effect.each(["completed", "failed", "interrupted", "cancelled"] as const)(
    "expires a callback whose new provider turn is %s",
    (status) =>
      Effect.gen(function* () {
        const state = yield* fixture();
        const events: OrchestrationV2DomainEvent[] = [
          state.requested,
          {
            ...state.base,
            type: "provider-turn.updated",
            payload: {
              id: state.request.providerTurnId!,
              providerThreadId: state.run.providerThreadId!,
              nodeId: state.request.nodeId,
              runAttemptId: state.run.activeAttemptId,
              nativeTurnRef: null,
              ordinal: 1,
              status,
              startedAt: state.now,
              completedAt: state.now,
            },
          },
        ];
        expect(requestAfter(state, expireRuntimeRequests(state.projection, events))?.status).toBe(
          "expired",
        );
      }),
  );

  it.effect.each(["stopped", "error"] as const)(
    "expires callbacks when their session becomes %s",
    (status) =>
      Effect.gen(function* () {
        const state = yield* fixture();
        const events: OrchestrationV2DomainEvent[] = [
          state.requested,
          {
            ...state.base,
            type: "provider-session.updated",
            payload: { ...state.session, status },
          },
        ];
        expect(requestAfter(state, expireRuntimeRequests(state.projection, events))?.status).toBe(
          "expired",
        );
      }),
  );

  it.effect("preserves resolved and message-mode requests when the run ends", () =>
    Effect.gen(function* () {
      const state = yield* fixture();
      for (const request of [
        {
          ...state.request,
          status: "resolved" as const,
          resolvedAt: state.now,
          answers: { city: "Zurich" },
        },
        { ...state.request, responseCapability: { type: "message" as const } },
      ]) {
        const events: OrchestrationV2DomainEvent[] = [
          { ...state.requested, payload: request },
          state.linked,
          {
            ...state.base,
            type: "run.updated",
            payload: { ...state.run, status: "failed", completedAt: state.now },
          },
        ];
        expect(expireRuntimeRequests(state.projection, events)).toBe(events);
        expect(requestAfter(state, events)).toEqual(request);
      }
    }),
  );
});
