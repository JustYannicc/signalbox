import { RuntimeRequestId } from "@t3tools/contracts";
import type { SignalboxAsk, SignalboxAskQuestion } from "@t3tools/contracts/signalboxAsks";
import { describe, expect, it } from "vite-plus/test";

import { buildAskRoundAnswer, visiblePendingAsks } from "./signalboxAsks.ts";

const now = "2026-10-16T12:00:00.000Z";
const question = (id: string): SignalboxAskQuestion => ({
  id,
  question: `Question ${id}?`,
  why: "Needs a decision",
  unblocks: "The next step",
  decisionOwner: "You",
  recommendation: { mode: "small" },
  blocking: true,
  options: [
    { label: "Small", value: { mode: "small" } },
    { label: "Large", value: 0 },
  ],
  surface: { kind: "kit", component: "choice" },
});

const ask: SignalboxAsk = {
  id: "ask",
  kind: "blocker",
  status: "pending",
  source: { kind: "agent" },
  createdAt: now,
  updatedAt: now,
  questions: [question("one"), question("two")],
  rounds: [
    {
      number: 3,
      questionIds: ["one", "two"],
      answers: [],
      deferredQuestionIds: [],
      openedAt: now,
      closedAt: null,
    },
  ],
};

describe("durable ask answers", () => {
  it("preserves a structured choice and its comment while deferring the remainder", () => {
    expect(
      buildAskRoundAnswer(ask, {
        one: { selectedOptionIndexes: [0], text: " Keep this small " },
      }),
    ).toEqual({
      round: 3,
      answers: [{ questionId: "one", value: { mode: "small" }, comment: "Keep this small" }],
      deferredQuestionIds: ["two"],
    });
  });

  it("allows free text without a choice and preserves falsey structured values", () => {
    expect(
      buildAskRoundAnswer(ask, {
        one: { selectedOptionIndexes: [], text: "Something else" },
        two: { selectedOptionIndexes: [1], text: "" },
      }).answers,
    ).toEqual([
      { questionId: "one", value: "Something else" },
      { questionId: "two", value: 0 },
    ]);
  });

  it("only submits current questions and supports recommendation plus commentary", () => {
    const current = {
      ...ask,
      rounds: [{ ...ask.rounds[0], questionIds: ["two"] }],
    } satisfies SignalboxAsk;
    expect(
      buildAskRoundAnswer(current, {
        one: { selectedOptionIndexes: [0], text: "Old draft" },
        two: { selectedOptionIndexes: [], useRecommendation: true, text: "Yes" },
      }),
    ).toEqual({
      round: 3,
      answers: [{ questionId: "two", value: { mode: "small" }, comment: "Yes" }],
      deferredQuestionIds: [],
    });
  });

  it("returns every unanswered question when a round is deferred", () => {
    expect(buildAskRoundAnswer(ask, {})).toEqual({
      round: 3,
      answers: [],
      deferredQuestionIds: ["one", "two"],
    });
  });

  it("keeps multi-select values structured", () => {
    const multi = {
      ...ask,
      questions: [
        { ...ask.questions[0], multiSelect: true },
        { ...question("two"), multiSelect: true },
      ] as const,
    };
    expect(
      buildAskRoundAnswer(multi, { one: { selectedOptionIndexes: [0, 1], text: "Both" } })
        .answers[0],
    ).toEqual({ questionId: "one", value: [{ mode: "small" }, 0], comment: "Both" });
  });
});

it("uses native controls until the request expires, then exposes its durable fallback", () => {
  const native = {
    ...ask,
    source: { kind: "native", requestId: RuntimeRequestId.make("request") },
  } satisfies SignalboxAsk;
  const request = { id: "request", status: "pending", responseCapability: { type: "live" } };
  expect(visiblePendingAsks([native], [request])).toEqual([]);
  expect(
    visiblePendingAsks([native], [{ ...request, responseCapability: { type: "message" } }]),
  ).toEqual([]);
  expect(
    visiblePendingAsks([native], [{ ...request, responseCapability: { type: "not_resumable" } }]),
  ).toEqual([native]);
  expect(visiblePendingAsks([native], [{ ...request, status: "expired" }])).toEqual([native]);
  expect(visiblePendingAsks([native], [])).toEqual([native]);
  expect(visiblePendingAsks([{ ...native, status: "answered" }], [])).toEqual([]);
});

it("leaves automation forms in the existing automation panel", () => {
  const automation = {
    ...ask,
    source: { kind: "automation", runId: "run", stepKey: "step" },
  } satisfies SignalboxAsk;
  expect(visiblePendingAsks([automation, ask], [])).toEqual([ask]);
});
