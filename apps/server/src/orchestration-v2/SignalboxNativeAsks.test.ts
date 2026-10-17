import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  TurnItemId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import { nativeCodexQuestions } from "../provider/nativeCodexQuestions.ts";
import { layer, threadId, create, answer, instanceId, driver } from "./SignalboxAsks.testkit.ts";

const native = (now: DateTime.Utc, suffix = "native", includeSecret = false) => {
  const requestId = RuntimeRequestId.make(suffix);
  const nodeId = NodeId.make(`${suffix}-node`);
  const sessionId = ProviderSessionId.make(`${suffix}-session`);
  const request: OrchestrationV2RuntimeRequest = {
    id: requestId,
    nodeId,
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "user_input",
    status: "pending",
    responseCapability: { type: "live", providerSessionId: sessionId },
    createdAt: now,
    resolvedAt: null,
  };
  const events: OrchestrationV2DomainEvent[] = [
    {
      type: "provider-session.attached",
      id: EventId.make(`${suffix}-session`),
      threadId,
      occurredAt: now,
      payload: {
        id: sessionId,
        driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: "/tmp",
        model: "gpt-6.1-sol",
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    },
    {
      type: "runtime-request.updated",
      id: EventId.make(`${suffix}-request`),
      threadId,
      occurredAt: now,
      payload: request,
    },
    {
      type: "turn-item.updated",
      id: EventId.make(`${suffix}-item`),
      threadId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(`${suffix}-item`),
        threadId,
        runId: null,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        title: "Native question",
        ordinal: 1,
        status: "waiting",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "user_input_request",
        requestId,
        questions: [
          {
            id: "a",
            header: "Pick",
            question: "Pick a font",
            options: [{ label: "A", description: "Font A", preview: "<b>A</b>" }],
            native: { isBlocking: false },
            allowCustomAnswer: true,
            multiSelect: true,
          },
          ...(includeSecret
            ? [
                {
                  id: "secret",
                  header: "Secret",
                  question: "Password",
                  options: [],
                  native: { isSecret: true },
                },
              ]
            : []),
        ],
      },
    },
  ];
  return { request, events };
};

it.effect(
  "keeps an assistant's native answer provenance and Codex recommendation after replay",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* create;
      const sink = yield* EventSink.EventSinkV2;
      const { request, events } = native(yield* DateTime.now, "assistant-answer");
      yield* sink.write({
        events: events.map((event) =>
          event.type === "turn-item.updated" && event.payload.type === "user_input_request"
            ? {
                ...event,
                payload: {
                  ...event.payload,
                  questions: nativeCodexQuestions(
                    [
                      {
                        id: "a",
                        header: "Font",
                        question: "Pick a font",
                        options: [
                          { label: "A (Recommended)", description: "Font A" },
                          { label: "B", description: "Font B" },
                        ],
                      },
                    ],
                    true,
                  ),
                },
              }
            : event,
        ),
      });
      yield* orchestrator.dispatch({
        type: "thread.native-ask.respond",
        commandId: CommandId.make("assistant-native-answer"),
        threadId,
        requestId: request.id,
        answers: { a: "A (Recommended)" },
        answeredBy: {
          kind: "assistant",
          personId: "thread-owner",
          assistantThreadId: ThreadId.make("assistant-caller"),
        },
      });
      yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
      const ask = (yield* orchestrator.getThreadProjection(threadId)).thread.asks?.[0];
      expect(ask?.status).toBe("answered");
      expect(ask?.rounds[0]?.answers[0]).toMatchObject({
        recommendationTaken: true,
        answeredBy: { kind: "assistant", assistantThreadId: "assistant-caller" },
      });
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      expect(
        (yield* outbox.listByCommandId(CommandId.make("assistant-native-answer"))).some(
          (effect) => effect.request.type === "runtime-request.respond",
        ),
      ).toBe(true);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "mirrors native flags and previews, excludes secrets, and delivers after callback expiration and replay",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* create;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const { request, events } = native(now, "native", true);
      yield* sink.write({ events });
      const ask = (yield* orchestrator.getThreadProjection(threadId)).thread.asks?.[0];
      expect(ask?.questions).toHaveLength(1);
      expect(ask?.questions[0]).toMatchObject({
        blocking: false,
        multiSelect: true,
        options: [{ preview: "<b>A</b>" }],
      });
      yield* sink.write({
        events: [
          {
            type: "runtime-request.updated",
            id: EventId.make("expired"),
            threadId,
            occurredAt: now,
            payload: {
              ...request,
              status: "expired",
              responseCapability: { type: "not_resumable", reason: "Session ended" },
              resolvedAt: now,
            },
          },
        ],
      });
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      yield* maintenance.rebuild;
      expect((yield* orchestrator.getThreadProjection(threadId)).thread.asks?.[0]?.status).toBe(
        "pending",
      );
      yield* orchestrator.dispatch(answer(ask!.id));
      const projection = yield* orchestrator.getThreadProjection(threadId);
      expect(projection.thread.asks?.[0]?.status).toBe("answered");
      expect(projection.messages.at(-1)?.text).toContain("Pick a font");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "native live answers use the existing runtime response outbox and direct native answers settle the mirror",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* create;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const { request, events } = native(now);
      yield* sink.write({ events });
      const command = answer(`native:${request.id}`);
      yield* orchestrator.dispatch(command);
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      expect(
        (yield* outbox.listByCommandId(command.commandId)).some(
          (effect) => effect.request.type === "runtime-request.respond",
        ),
      ).toBe(true);
      expect((yield* orchestrator.getThreadProjection(threadId)).messages).toEqual([]);
      expect((yield* orchestrator.getThreadProjection(threadId)).thread.asks?.[0]?.status).toBe(
        "answered",
      );
      const direct = native(now, "direct");
      yield* sink.write({ events: direct.events });
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("direct-answer"),
        threadId,
        requestId: direct.request.id,
        answers: { a: ["A"] },
      });
      const mirror = (yield* orchestrator.getThreadProjection(threadId)).thread.asks?.find(
        (ask) => ask.id === "native:direct",
      );
      expect(mirror?.status).toBe("answered");
      expect(mirror?.rounds[0]?.answers[0]).toMatchObject({
        value: ["A"],
        answeredBy: { kind: "person" },
      });
    }).pipe(Effect.provide(layer)),
);

it.effect("keeps structured native answers typed and delivers accompanying free comments", () =>
  Effect.gen(function* () {
    const orchestrator = yield* create;
    const sink = yield* EventSink.EventSinkV2;
    const { request, events } = native(yield* DateTime.now);
    yield* sink.write({ events });
    const command = {
      ...answer(`native:${request.id}`),
      answers: [{ questionId: "a", value: ["A"], comment: "Use the serif version" }],
      comment: "Keep the page readable",
    };
    yield* orchestrator.dispatch(command);
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const response = (yield* outbox.listByCommandId(command.commandId)).find(
      (effect) => effect.request.type === "runtime-request.respond",
    );
    expect(response?.request).toMatchObject({
      type: "runtime-request.respond",
      answers: { a: ["A"] },
    });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    expect(projection.messages.at(-1)?.text).toContain("Use the serif version");
    expect(projection.messages.at(-1)?.text).toContain("Keep the page readable");
  }).pipe(Effect.provide(layer)),
);

it.effect("leaves secret fields on their original request when the public ask is answered", () =>
  Effect.gen(function* () {
    const orchestrator = yield* create;
    const sink = yield* EventSink.EventSinkV2;
    const { request, events } = native(yield* DateTime.now, "mixed", true);
    yield* sink.write({ events });
    const command = answer(`native:${request.id}`);
    yield* orchestrator.dispatch(command);
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    expect(
      (yield* outbox.listByCommandId(command.commandId)).some(
        (effect) => effect.request.type === "runtime-request.respond",
      ),
    ).toBe(false);
    const projection = yield* orchestrator.getThreadProjection(threadId);
    expect(projection.runtimeRequests.find((entry) => entry.id === request.id)?.status).toBe(
      "pending",
    );
    expect(projection.thread.asks?.[0]?.status).toBe("answered");
    expect(projection.thread.asks?.[0]?.questions.map((question) => question.id)).toEqual(["a"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("holds partial native rounds without queuing a stale message behind the callback", () =>
  Effect.gen(function* () {
    const orchestrator = yield* create;
    const sink = yield* EventSink.EventSinkV2;
    const { request, events } = native(yield* DateTime.now);
    yield* sink.write({
      events: events.map((event) =>
        event.type !== "turn-item.updated" || event.payload.type !== "user_input_request"
          ? event
          : {
              ...event,
              payload: {
                ...event.payload,
                questions: [
                  ...event.payload.questions,
                  { ...event.payload.questions[0]!, id: "b" },
                ],
              },
            },
      ),
    });
    const command = answer(`native:${request.id}`);
    yield* orchestrator.dispatch(command);
    const projection = yield* orchestrator.getThreadProjection(threadId);
    expect(projection.thread.asks?.[0]?.rounds.at(-1)?.questionIds).toEqual(["b"]);
    expect(projection.messages).toEqual([]);
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    expect(yield* outbox.listByCommandId(command.commandId)).toEqual([]);
    yield* orchestrator.dispatch({
      ...command,
      commandId: CommandId.make("finish-partial"),
      round: 2,
      answers: [{ questionId: "b", value: ["B"] }],
    });
    const final = (yield* outbox.listByCommandId(CommandId.make("finish-partial"))).find(
      (effect) => effect.request.type === "runtime-request.respond",
    );
    expect(final?.request).toMatchObject({ answers: { a: "yes", b: ["B"] } });
    expect((yield* orchestrator.getThreadProjection(threadId)).messages).toEqual([]);
  }).pipe(Effect.provide(layer)),
);

it.effect("resumes held native answers after the provider session dies between rounds", () =>
  Effect.gen(function* () {
    const orchestrator = yield* create;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const { request, events } = native(now, "held-then-expired");
    yield* sink.write({
      events: events.map((event) =>
        event.type !== "turn-item.updated" || event.payload.type !== "user_input_request"
          ? event
          : {
              ...event,
              payload: {
                ...event.payload,
                questions: [
                  ...event.payload.questions,
                  { ...event.payload.questions[0]!, id: "b" },
                ],
              },
            },
      ),
    });
    const command = { ...answer(`native:${request.id}`), comment: "Keep the first choice" };
    yield* orchestrator.dispatch(command);
    expect((yield* orchestrator.getThreadProjection(threadId)).messages).toEqual([]);
    const session = (yield* orchestrator.getThreadProjection(threadId)).providerSessions[0]!;
    yield* sink.write({
      events: [
        {
          type: "provider-session.updated",
          id: EventId.make("stop-held-session"),
          threadId,
          occurredAt: now,
          payload: { ...session, status: "stopped", updatedAt: now },
        },
      ],
    });
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    yield* maintenance.rebuild;
    yield* orchestrator.dispatch({
      ...command,
      commandId: CommandId.make("finish-after-session-loss"),
      round: 2,
      comment: "Finish the rest",
      answers: [{ questionId: "b", value: ["B"] }],
    });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const reply = projection.messages.at(-1)?.text;
    expect(reply).toContain("Answer: yes");
    expect(reply).toContain('Answer: ["B"]');
    expect(reply).toContain("Keep the first choice");
    expect(reply).toContain("Finish the rest");
    expect(projection.thread.asks?.[0]?.status).toBe("answered");
  }).pipe(Effect.provide(layer)),
);
