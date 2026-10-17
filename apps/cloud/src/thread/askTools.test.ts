import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { CloudThreadService } from "./CloudThreadService.ts";
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
        surface: { kind: "kit", component: "text" },
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
      yield* cloud.settle;
    }),
);
