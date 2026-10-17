import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { OrchestrationV2Command } from "@t3tools/contracts";
import { SignalboxAsk } from "@t3tools/contracts/signalboxAsks";

const decodeAsk = Schema.decodeUnknownSync(SignalboxAsk);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);

it("rejects automation journal sync through the public command decoder", () => {
  const ask = decodeAsk({
    id: "automation:run:step",
    kind: "ready",
    status: "pending",
    source: { kind: "automation", runId: "run", stepKey: "step" },
    questions: [
      {
        id: "go",
        question: "Merge?",
        why: "Prepared",
        unblocks: "Merge",
        recommendation: true,
        options: [],
        blocking: false,
        decisionOwner: "Owner",
        surface: { kind: "kit", component: "text" },
      },
    ],
    rounds: [
      {
        number: 1,
        questionIds: ["go"],
        answers: [],
        deferredQuestionIds: [],
        openedAt: "2026-10-17T10:00:00.000Z",
        closedAt: null,
      },
    ],
    createdAt: "2026-10-17T10:00:00.000Z",
    updatedAt: "2026-10-17T10:00:00.000Z",
  });
  expect(() =>
    decodeCommand({
      type: "thread.ask.sync",
      commandId: "forged-sync",
      threadId: "thread",
      ask,
    }),
  ).toThrow();
});

it("rejects trusted native-answer provenance through the public command decoder", () => {
  expect(() =>
    decodeCommand({
      type: "thread.native-ask.respond",
      commandId: "forged-answer",
      threadId: "thread",
      requestId: "request",
      answers: { city: "Bern" },
      answeredBy: { kind: "assistant", personId: "owner", assistantThreadId: "forged" },
    }),
  ).toThrow();
});
