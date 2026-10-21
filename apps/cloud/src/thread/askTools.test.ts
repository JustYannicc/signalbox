import { ChatAttachmentId, CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { CloudThreadService } from "./CloudThreadService.ts";
import { Threads } from "./Threads.ts";
import { scriptedModelSelection } from "./scriptedProvider.ts";

it.effect(
  "the machine's tool channel raises and answers durable asks with trusted provenance",
  () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      const userId = "ask-owner";
      const actor = { userId, contextIds: [PERSONAL_CONTEXT_ID] };
      const threadId = ThreadId.make("ask-tool-thread");
      const user = cloud.userDirectory.forUser(userId);
      yield* user.recordSignIn({ id: userId, email: "ask@example.test" });
      const threads = yield* CloudThreadService.pipe(Effect.provide(cloud.layerFor(userId)));
      yield* threads.launchThread(actor, {
        commandId: CommandId.make("ask-tool-launch"),
        threadId,
        projectId: Environment.SCRATCH_PROJECT_ID,
        title: "Ask tool",
        modelSelection: scriptedModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make("ask-tool-message"),
          text: "Work",
          attachments: [],
        },
      });
      yield* cloud.settle;
      const question = {
        id: "destination",
        question: "Which city?",
        why: "The route needs a destination.",
        unblocks: "Planning the route.",
        recommendation: "Zurich",
        options: [],
        blocking: false,
        decisionOwner: "Thread owner",
        surface: { kind: "kit" as const, component: "text" },
      };
      const input = {
        clientRequestId: "city",
        kind: "blocker",
        questions: [question],
        source: { kind: "automation" },
      };
      const raised = yield* user.automationTool(threadId, "t3_ask_raise", input);
      expect(raised).toMatchObject({ _tag: "ok", result: { round: 1 } });
      expect(yield* user.automationTool(threadId, "t3_ask_raise", input)).toEqual(raised);
      const askId = `ask:${threadId}:city`;
      expect(yield* user.automationTool(threadId, "t3_ask_read", { askId })).toMatchObject({
        _tag: "ok",
        result: { ask: { source: { kind: "agent" }, status: "pending" } },
      });
      expect(
        yield* user.automationTool(threadId, "t3_ask_answer", {
          askId,
          round: 1,
          answers: [{ questionId: "destination", value: "Zurich" }],
          answeredBy: { kind: "person", personId: "spoofed" },
        }),
      ).toMatchObject({ _tag: "ok" });
      const { projection } = yield* threads.threadSnapshot(actor, threadId);
      expect(projection.thread.asks).toHaveLength(1);
      expect(projection.thread.asks?.[0]?.rounds[0]?.answers[0]).toMatchObject({
        answeredBy: { kind: "assistant", personId: userId, assistantThreadId: threadId },
        recommendationTaken: true,
      });
      expect(projection.messages.at(-1)?.text).toContain("Zurich");
      const answered = projection.thread.asks?.[0];
      if (!answered) throw new Error("The answered ask was not persisted");
      yield* threads.syncAutomationAsk(actor, threadId, {
        ...answered,
        id: "workflow-ask",
        source: { kind: "automation", runId: "workflow-run", stepKey: "gate" },
      });
      expect(
        (yield* threads.threadSnapshot(actor, threadId)).projection.thread.asks?.find(
          (ask) => ask.id === "workflow-ask",
        ),
      ).toMatchObject({
        source: { kind: "automation", runId: "workflow-run" },
        status: "answered",
      });
      const coreThreads = yield* Threads.pipe(Effect.provide(cloud.layerFor(userId)));
      yield* coreThreads.dispatch(actor, {
        type: "thread.ask.raise",
        commandId: CommandId.make("public-forged-source"),
        threadId,
        askId: "public-ask",
        ask: {
          kind: "blocker",
          source: { kind: "agent" },
          questions: [question],
        },
      });
      expect(
        (yield* threads.threadSnapshot(actor, threadId)).projection.thread.asks?.find(
          (ask) => ask.id === "public-ask",
        )?.source,
      ).toEqual({ kind: "agent" });
      yield* coreThreads.dispatch(actor, {
        type: "thread.ask.answer",
        commandId: CommandId.make("public-forged-answerer"),
        threadId,
        askId: "public-ask",
        round: 1,
        answers: [{ questionId: question.id, value: "Zurich" }],
        deferredQuestionIds: [],
        answeredBy: { kind: "assistant", personId: "victim", assistantThreadId: threadId },
      });
      expect(
        (yield* threads.threadSnapshot(actor, threadId)).projection.thread.asks?.find(
          (ask) => ask.id === "public-ask",
        )?.rounds[0]?.answers[0]?.answeredBy,
      ).toEqual({ kind: "person", personId: userId });
      const missingExit = yield* user.automationTool(threadId, "t3_ask_raise", {
        clientRequestId: "missing-exit",
        kind: "considering",
        questions: [question],
      });
      expect(missingExit._tag).toBe("failed");
      const invalidPreparation = yield* user.automationTool(threadId, "t3_ask_raise", {
        clientRequestId: "invalid-preparation",
        kind: "considering",
        questions: [question],
        considering: {
          exit: { kind: "date", at: "2026-10-19T10:00:00.000Z" },
          preparationAttachmentIds: [
            ChatAttachmentId.make("pending-00000000-0000-4000-8000-000000000000"),
          ],
        },
      });
      expect(invalidPreparation._tag).toBe("failed");
      yield* cloud.settle;
    }),
);

it.effect("fires a Considering exit only for its revision and current owner home", () =>
  Effect.gen(function* () {
    const cloud = makeMemoryCloud();
    const userId = "considering-owner";
    const actor = { userId, contextIds: [PERSONAL_CONTEXT_ID] };
    const threadId = ThreadId.make("considering-thread");
    const user = cloud.userDirectory.forUser(userId);
    yield* user.recordSignIn({ id: userId, email: "considering@example.test" });
    const threads = yield* CloudThreadService.pipe(Effect.provide(cloud.layerFor(userId)));
    yield* threads.launchThread(actor, {
      commandId: CommandId.make("considering-launch"),
      threadId,
      projectId: Environment.SCRATCH_PROJECT_ID,
      title: "Considering ask",
      modelSelection: scriptedModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: {
        messageId: MessageId.make("considering-message"),
        text: "Work",
        attachments: [],
      },
    });
    yield* cloud.settle;
    const question = {
      id: "decision",
      question: "Which option?",
      why: "The tradeoff needs time.",
      unblocks: "The next step.",
      recommendation: "A",
      options: [],
      blocking: false,
      decisionOwner: "Thread owner",
      surface: { kind: "kit" as const, component: "text" },
    };
    yield* threads.dispatchCommand(actor, {
      type: "thread.ask.raise",
      commandId: CommandId.make("considering-raise"),
      threadId,
      askId: "considering-ask",
      ask: {
        kind: "considering",
        source: { kind: "agent" },
        questions: [question],
        considering: {
          exit: { kind: "event", name: "The customer replies" },
          preparationAttachmentIds: [],
        },
      },
    });
    yield* threads.dispatchCommand(actor, {
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
    const invalidRedeferAttachment = yield* Effect.exit(
      threads.dispatchCommand(actor, {
        type: "thread.ask.considering.redefer",
        commandId: CommandId.make("considering-redefer-invalid-attachment"),
        threadId,
        askId: "considering-ask",
        expectedRevision: 2,
        considering: {
          exit: { kind: "event", name: "The case changes" },
          preparationAttachmentIds: [
            ChatAttachmentId.make("pending-00000000-0000-4000-8000-000000000000"),
          ],
        },
      }),
    );
    expect(Exit.isFailure(invalidRedeferAttachment)).toBe(true);
    const staleRedefer = yield* Effect.exit(
      threads.dispatchCommand(actor, {
        type: "thread.ask.considering.redefer",
        commandId: CommandId.make("considering-stale-redefer"),
        threadId,
        askId: "considering-ask",
        expectedRevision: 1,
        considering: {
          exit: { kind: "date", at: "2026-10-19T10:00:00.000Z" },
          preparationAttachmentIds: [],
        },
      }),
    );
    expect(Exit.isFailure(staleRedefer)).toBe(true);

    const fire = {
      type: "thread.ask.considering.fire" as const,
      commandId: CommandId.make("considering-fire"),
      threadId,
      askId: "considering-ask",
      expectedRevision: 2,
      proof: {
        kind: "evidence" as const,
        source: "message.sent" as const,
        eventId: "event:message-support-case",
        judgment: "materially_changes" as const,
      },
      expectedHome: {
        kind: "cloud" as const,
        projectId: Environment.SCRATCH_PROJECT_ID,
        contextId: PERSONAL_CONTEXT_ID,
        driveId: `my/personal/${userId}`,
      },
    };
    const wrongHome = yield* Effect.exit(
      threads.fireConsideringAsk(actor, {
        ...fire,
        commandId: CommandId.make("considering-wrong-home"),
        expectedHome: { ...fire.expectedHome, projectId: ProjectId.make("another-project") },
      }),
    );
    expect(Exit.isFailure(wrongHome)).toBe(true);
    const wrongHost = yield* Effect.exit(
      threads.fireConsideringAsk(actor, {
        ...fire,
        commandId: CommandId.make("considering-wrong-host"),
        expectedHome: {
          kind: "server" as const,
          projectId: Environment.SCRATCH_PROJECT_ID,
          workspaceRoot: "/work/project",
        },
      } as unknown as typeof fire),
    );
    expect(Exit.isFailure(wrongHost)).toBe(true);
    const wrongProof = yield* Effect.exit(
      threads.fireConsideringAsk(actor, {
        ...fire,
        commandId: CommandId.make("considering-wrong-evidence-source"),
        proof: { ...fire.proof, source: "drive.changed" },
      }),
    );
    expect(Exit.isFailure(wrongProof)).toBe(true);
    const fired = yield* threads.fireConsideringAsk(actor, fire);
    const sequence = (yield* threads.threadSnapshot(actor, threadId)).snapshotSequence;
    expect(fired.sequence).toBe(sequence);
    expect(
      (yield* threads.threadSnapshot(actor, threadId)).projection.thread.asks?.[0],
    ).toMatchObject({
      considering: {
        revision: 2,
        fired: {
          source: "evidence",
          whatChanged:
            "Evidence item event:message-support-case from message.sent materially changed this decision.",
          proof: fire.proof,
        },
      },
    });

    const changedHomeReplay = yield* Effect.exit(
      threads.fireConsideringAsk(actor, {
        ...fire,
        expectedHome: { ...fire.expectedHome, driveId: "my/personal/moved" },
      }),
    );
    expect(Exit.isFailure(changedHomeReplay)).toBe(true);

    const repeated = yield* threads.fireConsideringAsk(actor, {
      ...fire,
      commandId: CommandId.make("considering-fire-retry"),
    });
    expect(repeated.sequence).toBe(sequence);
    const unauthorized = yield* Effect.exit(
      threads.fireConsideringAsk(
        { userId: "another-user", contextIds: actor.contextIds },
        {
          ...fire,
          commandId: CommandId.make("considering-other-owner"),
        },
      ),
    );
    expect(Exit.isFailure(unauthorized)).toBe(true);
    yield* cloud.settle;
  }),
);
