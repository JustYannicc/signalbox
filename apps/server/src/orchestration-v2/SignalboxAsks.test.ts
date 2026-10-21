import { expect, it } from "@effect/vitest";
import { ChatAttachmentId, CommandId, EventId, MessageId, ProjectId } from "@t3tools/contracts";
import type { SignalboxAsk } from "@t3tools/contracts/signalboxAsks";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { applyAskCommand } from "@t3tools/shared/signalboxAsks";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { layer, threadId, create, raise, answer } from "./SignalboxAsks.testkit.ts";

const automationAsk = (now: string): SignalboxAsk => ({
  kind: "ready",
  questions: raise.ask.questions,
  source: { kind: "automation", runId: "run", stepKey: "gate" },
  id: raise.askId,
  status: "pending",
  rounds: [
    {
      number: 1,
      questionIds: raise.ask.questions.map((question) => question.id),
      answers: [],
      deferredQuestionIds: [],
      openedAt: now,
      closedAt: null,
    },
  ],
  createdAt: now,
  updatedAt: now,
});

it.effect(
  "keeps work active, queues a partial answer and restores pending rounds from events",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* create;
      yield* orchestrator.dispatch(raise);
      expect((yield* orchestrator.getThreadProjection(threadId)).runs).toEqual([]);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("continue"),
        threadId,
        messageId: MessageId.make("continue"),
        text: "Keep working independently",
        attachments: [],
        createdBy: "agent",
        creationSource: "mcp",
        dispatchMode: { type: "start_immediately" },
      });
      const result = yield* orchestrator.dispatch(answer());
      expect(
        result.storedEvents.some(({ event }) => event.type === "thread.metadata-updated"),
      ).toBe(true);
      expect(result.storedEvents.some(({ event }) => event.type === "message.updated")).toBe(true);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      expect(projection.runs.map((run) => run.status)).toEqual(["starting", "queued"]);
      expect(projection.thread.asks?.[0]?.rounds[1]?.questionIds).toEqual(["b"]);
      expect(projection.messages.at(-1)?.text).toContain("Why: Need your preference");
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      expect((yield* maintenance.rebuild).valid).toBe(true);
      expect((yield* orchestrator.getThreadProjection(threadId)).thread.asks).toEqual(
        projection.thread.asks,
      );
      expect((yield* orchestrator.getThreadShell(threadId))?.asks).toEqual(projection.thread.asks);
      const replay = yield* orchestrator.dispatch(answer());
      expect(replay.sequence).toBe(result.sequence);
      expect((yield* orchestrator.getThreadProjection(threadId)).messages).toHaveLength(2);
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive"),
        threadId,
      });
      const archived = (yield* orchestrator.getThreadProjection(threadId)).thread.asks?.[0];
      expect(archived?.status).toBe("archived");
      expect(archived?.rounds[0]?.answers).toHaveLength(1);
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("reopen"),
        threadId,
      });
      const reopened = (yield* orchestrator.getThreadProjection(threadId)).thread.asks?.[0];
      expect(reopened?.status).toBe("pending");
      expect(reopened?.rounds.at(-1)?.closedAt).toBeNull();
      yield* orchestrator.dispatch({
        ...answer(),
        commandId: CommandId.make("answer-reopened"),
        round: 2,
        answers: [{ questionId: "b", value: "B" }],
      });
      expect((yield* orchestrator.getThreadProjection(threadId)).thread.asks?.[0]?.status).toBe(
        "answered",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("re-defers, resumes and fires Considering through the server-only command path", () =>
  Effect.gen(function* () {
    const orchestrator = yield* create;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projectId = ProjectId.make("project:asks");
    yield* projects.apply({
      sequence: 1,
      eventId: EventId.make("event:project-asks-created"),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: "2026-10-16T10:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: "Asks",
        workspaceRoot: "/tmp/project-asks",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-10-16T10:00:00.000Z",
        updatedAt: "2026-10-16T10:00:00.000Z",
      },
    });
    const raised = yield* orchestrator.dispatch({
      ...raise,
      commandId: CommandId.make("considering-raise"),
      askId: "considering-ask",
      ask: {
        kind: "considering",
        source: { kind: "agent" },
        questions: [
          {
            id: "choice",
            question: "Which option?",
            why: "The tradeoff needs time.",
            unblocks: "The next step.",
            recommendation: "A",
            options: [],
            blocking: false,
            decisionOwner: "Owner",
            surface: { kind: "kit", component: "text" },
          },
        ],
        considering: {
          exit: { kind: "event", name: "The customer replies" },
          preparationAttachmentIds: [],
        },
      },
    });
    const changedAsks = (result: typeof raised) =>
      result.storedEvents.flatMap(({ event }) =>
        event.type === "thread.ask-updated" ? [event.payload] : [],
      );
    expect(changedAsks(raised)).toHaveLength(1);
    expect(changedAsks(raised)[0]).toMatchObject({
      id: "considering-ask",
      kind: "considering",
      considering: {
        revision: 1,
        exit: { kind: "event", name: "The customer replies" },
      },
    });
    const invalidRedeferAttachment = yield* Effect.exit(
      orchestrator.dispatch({
        type: "thread.ask.considering.redefer",
        commandId: CommandId.make("considering-invalid-attachment"),
        threadId,
        askId: "considering-ask",
        expectedRevision: 1,
        considering: {
          exit: { kind: "event", name: "The customer replies" },
          preparationAttachmentIds: [
            ChatAttachmentId.make("pending-00000000-0000-4000-8000-000000000000"),
          ],
        },
      }),
    );
    expect(Exit.isFailure(invalidRedeferAttachment)).toBe(true);
    const redeferred = yield* orchestrator.dispatch({
      type: "thread.ask.considering.redefer",
      commandId: CommandId.make("considering-redefer"),
      threadId,
      askId: "considering-ask",
      expectedRevision: 1,
      considering: {
        exit: {
          kind: "evidence",
          reference: "support case",
          relatednessCriteria: "The item concerns this customer's case.",
          materialChangeCriteria: "It changes the decision about the option.",
          sourceKinds: ["message.sent"],
        },
        preparationAttachmentIds: [],
      },
    });
    expect(changedAsks(redeferred)).toHaveLength(1);
    expect(changedAsks(redeferred)[0]).toMatchObject({
      id: "considering-ask",
      considering: {
        revision: 2,
        exit: { kind: "evidence", reference: "support case" },
      },
    });
    expect(changedAsks(redeferred)[0]?.considering?.fired).toBeUndefined();
    const resume = {
      type: "thread.ask.considering.resume",
      commandId: CommandId.make("considering-resume"),
      threadId,
      askId: "considering-ask",
      expectedRevision: 2,
      whatChanged: "The owner has time to revisit this now.",
    } as const;
    const resumed = yield* orchestrator.dispatch(resume);
    expect(changedAsks(resumed)).toHaveLength(1);
    expect(changedAsks(resumed)[0]).toMatchObject({
      id: "considering-ask",
      considering: {
        revision: 2,
        fired: {
          source: "owner",
          whatChanged: "The owner has time to revisit this now.",
          proof: { kind: "owner", whatChanged: "The owner has time to revisit this now." },
        },
      },
    });
    const repeatedResume = yield* orchestrator.dispatch({
      ...resume,
      commandId: CommandId.make("considering-resume-again"),
    });
    expect(repeatedResume.storedEvents).toEqual([]);
    expect(repeatedResume.sequence).toBe(resumed.sequence);
    expect((yield* orchestrator.dispatch(resume)).sequence).toBe(resumed.sequence);
    const redeferredAgain = yield* orchestrator.dispatch({
      type: "thread.ask.considering.redefer",
      commandId: CommandId.make("considering-redefer-after-resume"),
      threadId,
      askId: "considering-ask",
      expectedRevision: 2,
      considering: {
        exit: {
          kind: "evidence",
          reference: "support case",
          relatednessCriteria: "The item concerns this customer's case.",
          materialChangeCriteria: "It changes the decision about the option.",
          sourceKinds: ["message.sent"],
        },
        preparationAttachmentIds: [],
      },
    });
    expect(changedAsks(redeferredAgain)).toHaveLength(1);
    expect(changedAsks(redeferredAgain)[0]).toMatchObject({
      id: "considering-ask",
      considering: { revision: 3 },
    });
    expect(changedAsks(redeferredAgain)[0]?.considering?.fired).toBeUndefined();
    const previousHome = {
      kind: "server" as const,
      projectId,
      workspaceRoot: "/tmp/project-asks",
    };
    yield* projects.apply({
      sequence: 2,
      eventId: EventId.make("event:project-asks-moved"),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: "2026-10-16T10:01:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.meta-updated",
      payload: {
        projectId,
        workspaceRoot: "/tmp/project-asks-moved",
        updatedAt: "2026-10-16T10:01:00.000Z",
      },
    });
    const expectedHome = {
      kind: "server" as const,
      projectId,
      workspaceRoot: "/tmp/project-asks-moved",
    };
    const wrongHome = yield* Effect.exit(
      orchestrator.dispatch({
        type: "thread.ask.considering.fire",
        commandId: CommandId.make("considering-wrong-home"),
        threadId,
        askId: "considering-ask",
        expectedRevision: 3,
        proof: {
          kind: "evidence",
          source: "message.sent",
          eventId: "event:message-support-case",
          judgment: "materially_changes",
        },
        expectedHome: previousHome,
      }),
    );
    expect(Exit.isFailure(wrongHome)).toBe(true);
    const wrongHost = yield* Effect.exit(
      orchestrator.dispatch({
        type: "thread.ask.considering.fire",
        commandId: CommandId.make("considering-wrong-host"),
        threadId,
        askId: "considering-ask",
        expectedRevision: 3,
        proof: {
          kind: "evidence",
          source: "message.sent",
          eventId: "event:message-support-case",
          judgment: "materially_changes",
        },
        expectedHome: {
          kind: "cloud",
          projectId,
          contextId: SignalboxContextId.make("personal"),
          driveId: "local:asks",
        },
      }),
    );
    expect(Exit.isFailure(wrongHost)).toBe(true);
    const wrongProof = yield* Effect.exit(
      orchestrator.dispatch({
        type: "thread.ask.considering.fire",
        commandId: CommandId.make("considering-wrong-proof"),
        threadId,
        askId: "considering-ask",
        expectedRevision: 3,
        proof: {
          kind: "evidence",
          source: "drive.changed",
          eventId: "event:unrelated-drive-change",
          judgment: "materially_changes",
        },
        expectedHome,
      }),
    );
    expect(Exit.isFailure(wrongProof)).toBe(true);
    const fireCommand = {
      type: "thread.ask.considering.fire" as const,
      commandId: CommandId.make("considering-fire"),
      threadId,
      askId: "considering-ask",
      expectedRevision: 3,
      proof: {
        kind: "evidence" as const,
        source: "message.sent" as const,
        eventId: "event:message-support-case",
        judgment: "materially_changes" as const,
      },
      expectedHome,
    };
    const fired = yield* orchestrator.dispatch(fireCommand);
    expect(changedAsks(fired)).toHaveLength(1);
    expect(changedAsks(fired)[0]).toMatchObject({
      id: "considering-ask",
      considering: {
        revision: 3,
        fired: { source: "evidence", proof: fireCommand.proof },
      },
    });
    const afterFire = yield* orchestrator.getThreadProjection(threadId);
    expect(afterFire.thread.asks?.find((ask) => ask.id === "considering-ask")).toMatchObject({
      considering: {
        revision: 3,
        fired: {
          source: "evidence",
          whatChanged:
            "Evidence item event:message-support-case from message.sent materially changed this decision.",
          proof: fireCommand.proof,
        },
      },
    });
    const sequence = yield* orchestrator.getThreadEventSequence(threadId);
    const retried = yield* orchestrator.dispatch({
      ...fireCommand,
      commandId: CommandId.make("considering-fire-retry"),
    });
    expect(retried.sequence).toBe(fired.sequence);
    expect(changedAsks(retried)).toEqual([]);
    expect(yield* orchestrator.getThreadEventSequence(threadId)).toBe(sequence);
    yield* projects.apply({
      sequence: 3,
      eventId: EventId.make("event:project-asks-moved-again"),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: "2026-10-16T10:02:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.meta-updated",
      payload: {
        projectId,
        workspaceRoot: "/tmp/project-asks-moved-again",
        updatedAt: "2026-10-16T10:02:00.000Z",
      },
    });
    const staleReceiptHome = yield* Effect.exit(orchestrator.dispatch(fireCommand));
    expect(Exit.isFailure(staleReceiptHome)).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "commits answer, message and provider outbox together, rolling back if enqueue fails",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* create;
      yield* orchestrator.dispatch(raise);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER reject_ask_outbox BEFORE INSERT ON orchestration_v2_effect_outbox BEGIN SELECT RAISE(FAIL, 'outbox unavailable'); END`;
      const failed = yield* Effect.exit(orchestrator.dispatch(answer()));
      expect(Exit.isFailure(failed)).toBe(true);
      const unchanged = yield* orchestrator.getThreadProjection(threadId);
      expect(unchanged.thread.asks?.[0]?.rounds).toHaveLength(1);
      expect(unchanged.messages).toEqual([]);
      yield* sql`DROP TRIGGER reject_ask_outbox`;
      const command = { ...answer(), commandId: CommandId.make("answer:retry") };
      yield* orchestrator.dispatch(command);
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      expect((yield* outbox.listByCommandId(command.commandId)).length).toBeGreaterThan(0);
      expect(
        (yield* orchestrator.getThreadProjection(threadId)).thread.asks?.[0]?.rounds,
      ).toHaveLength(2);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "routes automation answers through the engine and accepts its sync without applying twice",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* create;
      yield* orchestrator.dispatch({
        type: "thread.ask.sync",
        commandId: CommandId.make("automation-ask-sync"),
        threadId,
        ask: automationAsk(DateTime.formatIso(yield* DateTime.now)),
      });
      const threads = yield* ThreadManagement.ThreadManagementService;
      let calls = 0;
      const mockEngine = Layer.mock(WorkflowEngine.WorkflowEngine)({
        validate: () => ({ ok: false, diagnostics: [] }),
        answerSignalboxAsk: (command, ask) =>
          Effect.gen(function* () {
            calls++;
            const applied = applyAskCommand(
              [ask],
              command,
              DateTime.formatIso(yield* DateTime.now),
            );
            if (!applied.ok) return yield* Effect.die(applied.error);
            yield* threads
              .dispatch({
                type: "thread.ask.sync",
                commandId: CommandId.make("engine-sync"),
                threadId,
                ask: applied.asks[0]!,
              })
              .pipe(Effect.orDie);
          }),
      });
      const result = yield* threads.dispatch(answer()).pipe(Effect.provide(mockEngine));
      expect(calls).toBe(1);
      expect(result.sequence).toBe(yield* orchestrator.getThreadEventSequence(threadId));
      const projection = yield* orchestrator.getThreadProjection(threadId);
      expect(projection.thread.asks?.[0]?.rounds).toHaveLength(2);
      expect(projection.messages).toEqual([]);
    }).pipe(Effect.provide(ThreadManagement.layer.pipe(Layer.provideMerge(layer)))),
);

it.effect("syncs a workflow outcome while archived and rejects withdrawing its wait", () =>
  Effect.gen(function* () {
    const orchestrator = yield* create;
    yield* orchestrator.dispatch({
      type: "thread.ask.sync",
      commandId: CommandId.make("automation-ask-sync-archived"),
      threadId,
      ask: automationAsk(DateTime.formatIso(yield* DateTime.now)),
    });
    const withdraw = yield* Effect.exit(
      orchestrator.dispatch({
        type: "thread.ask.withdraw",
        commandId: CommandId.make("withdraw-automation"),
        threadId,
        askId: raise.askId,
      }),
    );
    expect(Exit.isFailure(withdraw)).toBe(true);
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive-automation"),
      threadId,
    });
    const ask = (yield* orchestrator.getThreadProjection(threadId)).thread.asks![0]!;
    yield* orchestrator.dispatch({
      type: "thread.ask.sync",
      commandId: CommandId.make("sync-archived"),
      threadId,
      ask: { ...ask, status: "withdrawn" },
    });
    expect((yield* orchestrator.getThreadProjection(threadId)).thread.asks?.[0]?.status).toBe(
      "withdrawn",
    );
    yield* orchestrator.dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make("unarchive-automation"),
      threadId,
    });
    expect((yield* orchestrator.getThreadProjection(threadId)).thread.asks?.[0]?.status).toBe(
      "withdrawn",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps closed history out of shells and metadata events while preserving replay", () =>
  Effect.gen(function* () {
    const orchestrator = yield* create;
    const raised = yield* orchestrator.dispatch(raise);
    expect(raised.storedEvents.some(({ event }) => event.type === "thread.ask-updated")).toBe(true);
    yield* orchestrator.dispatch({
      ...answer(),
      answers: [
        { questionId: "a", value: "yes" },
        { questionId: "b", value: "yes" },
      ],
    });
    expect((yield* orchestrator.getThreadShell(threadId))?.asks).toEqual([]);
    const renamed = yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("rename-with-history"),
      threadId,
      title: "Renamed",
    });
    const event = renamed.storedEvents.find(
      ({ event }) => event.type === "thread.metadata-updated",
    )?.event;
    expect(event?.payload).not.toHaveProperty("asks");
    expect(renamed.storedEvents.some(({ event }) => event.type === "thread.ask-updated")).toBe(
      false,
    );
    const before = (yield* orchestrator.getThreadProjection(threadId)).thread.asks;
    expect(before?.[0]?.status).toBe("answered");
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    expect((yield* maintenance.rebuild).valid).toBe(true);
    expect((yield* orchestrator.getThreadProjection(threadId)).thread.asks).toEqual(before);
  }).pipe(Effect.provide(layer)),
);
