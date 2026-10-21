import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { OrchestrationV2Command } from "@t3tools/contracts";
import { SignalboxAsk, SignalboxAskServerCommand } from "@t3tools/contracts/signalboxAsks";

const decodeAsk = Schema.decodeUnknownSync(SignalboxAsk);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
const decodeServerCommand = Schema.decodeUnknownSync(SignalboxAskServerCommand);

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

it("requires an exit for public Considering raises and accepts legacy persisted asks", () => {
  const ask = {
    kind: "considering",
    source: { kind: "agent" },
    questions: [
      {
        id: "decision",
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
  };
  expect(() =>
    decodeCommand({
      type: "thread.ask.raise",
      commandId: "raise-considering",
      threadId: "thread",
      askId: "ask",
      ask,
    }),
  ).toThrow();
  expect(
    decodeCommand({
      type: "thread.ask.raise",
      commandId: "raise-considering-with-exit",
      threadId: "thread",
      askId: "ask",
      ask: {
        ...ask,
        considering: {
          exit: { kind: "event", name: "The customer replies" },
          preparationAttachmentIds: [],
        },
      },
    }),
  ).toMatchObject({ ask: { considering: { exit: { kind: "event" } } } });
  expect(() =>
    decodeCommand({
      type: "thread.ask.raise",
      commandId: "forged-native-raise",
      threadId: "thread",
      askId: "ask",
      ask: { ...ask, kind: "ready", source: { kind: "native", requestId: "request" } },
    }),
  ).toThrow();
  expect(() =>
    decodeAsk({
      id: "legacy",
      kind: "considering",
      source: { kind: "agent" },
      status: "pending",
      questions: ask.questions,
      rounds: [
        {
          number: 1,
          questionIds: ["decision"],
          answers: [],
          deferredQuestionIds: [],
          openedAt: "2026-10-17T10:00:00.000Z",
          closedAt: null,
        },
      ],
      createdAt: "2026-10-17T10:00:00.000Z",
      updatedAt: "2026-10-17T10:00:00.000Z",
    }),
  ).not.toThrow();
});

it("keeps exit fire server-only and carries the expected home identity", () => {
  const fire = {
    type: "thread.ask.considering.fire",
    commandId: "fire",
    threadId: "thread",
    askId: "ask",
    expectedRevision: 1,
    proof: {
      kind: "event",
      eventId: "event:customer-replied",
      name: "The customer replies",
      matchedFields: {},
    },
    expectedHome: { kind: "cloud", projectId: "project", contextId: "context", driveId: "drive" },
  };
  expect(decodeServerCommand(fire)).toMatchObject({ expectedHome: fire.expectedHome });
  expect(() => decodeCommand(fire)).toThrow();
  expect(() =>
    decodeServerCommand({ ...fire, proof: { ...fire.proof, eventId: undefined } }),
  ).toThrow();
  expect(
    decodeServerCommand({
      ...fire,
      expectedHome: { kind: "server", projectId: "project", workspaceRoot: "/work/project" },
      proof: {
        kind: "weekly-review",
        reviewedAt: "2026-10-23T10:00:00.000Z",
        staleSince: "2026-10-16T10:00:00.000Z",
        automationRunId: "run:weekly-review",
      },
    }),
  ).toMatchObject({ expectedHome: { kind: "server", workspaceRoot: "/work/project" } });
});

it("requires relatedness, material change and permitted sources for evidence exits", () => {
  const ask = {
    kind: "considering",
    source: { kind: "agent" },
    questions: [
      {
        id: "decision",
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
      exit: {
        kind: "evidence",
        reference: "support case 42",
        relatednessCriteria: "The item concerns this customer's case.",
        materialChangeCriteria: "It changes the decision.",
        sourceKinds: ["message.sent"],
      },
      preparationAttachmentIds: [],
    },
  };
  expect(
    decodeCommand({
      type: "thread.ask.raise",
      commandId: "raise-evidence",
      threadId: "thread",
      askId: "ask",
      ask,
    }),
  ).toMatchObject({ ask: { considering: { exit: { kind: "evidence" } } } });
  expect(() =>
    decodeCommand({
      type: "thread.ask.raise",
      commandId: "raise-evidence-without-criteria",
      threadId: "thread",
      askId: "ask",
      ask: {
        ...ask,
        considering: {
          ...ask.considering,
          exit: { kind: "evidence", reference: "support case 42" },
        },
      },
    }),
  ).toThrow();
  expect(() =>
    decodeCommand({
      type: "thread.ask.raise",
      commandId: "raise-evidence-without-sources",
      threadId: "thread",
      askId: "ask",
      ask: {
        ...ask,
        considering: {
          ...ask.considering,
          exit: {
            ...ask.considering.exit,
            sourceKinds: [],
          },
        },
      },
    }),
  ).toThrow();
});
