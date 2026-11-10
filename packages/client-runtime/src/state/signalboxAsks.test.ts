import { RuntimeRequestId } from "@t3tools/contracts";
import type { SignalboxAsk, SignalboxAskQuestion } from "@t3tools/contracts/signalboxAsks";
import { describe, expect, it } from "vite-plus/test";

import {
  askKitRecommendation,
  buildAskRoundAnswer,
  sameAskKitValue,
  visiblePendingAsks,
} from "@t3tools/client-runtime/state/signalboxAsks";

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
      problems: [],
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
      problems: [],
    });
  });

  it("returns every unanswered question when a round is deferred", () => {
    expect(buildAskRoundAnswer(ask, {})).toEqual({
      round: 3,
      answers: [],
      deferredQuestionIds: ["one", "two"],
      problems: [],
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

describe("kit drafts", () => {
  const kit = (
    id: string,
    component: string,
    props: Extract<SignalboxAskQuestion["surface"], { kind: "kit" }>["props"],
    changes: Partial<SignalboxAskQuestion> = {},
  ): SignalboxAskQuestion => ({
    ...question(id),
    recommendation: null,
    surface: { kind: "kit", component, ...(props === undefined ? {} : { props }) },
    ...changes,
  });
  const choices = kit(
    "pick",
    "choices",
    {},
    {
      options: [
        { label: "None", value: { plan: "none" } },
        { label: "Team", value: { plan: "team" } },
      ],
      recommendation: { plan: "team" },
    },
  );
  const slider = kit("budget", "slider", { min: 0, max: 100, step: 10 }, { options: [] });
  const ranking = kit(
    "order",
    "ranking",
    {},
    {
      options: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ],
    },
  );
  const round = (first: SignalboxAskQuestion, ...rest: SignalboxAskQuestion[]): SignalboxAsk => ({
    ...ask,
    questions: [first, ...rest],
    rounds: [{ ...ask.rounds[0]!, questionIds: [first, ...rest].map((item) => item.id) }],
  });
  const all = round(choices, slider, ranking);

  it("defers untouched components instead of sending a default", () => {
    expect(buildAskRoundAnswer(all, {})).toMatchObject({
      answers: [],
      deferredQuestionIds: ["pick", "budget", "order"],
    });
    // A comment alone on a kit component is a words-only answer, never a fake selection.
    expect(
      buildAskRoundAnswer(all, { budget: { selectedOptionIndexes: [], text: " Your call " } })
        .answers,
    ).toEqual([{ questionId: "budget", value: null, comment: "Your call" }]);
  });

  it("sends structured values by option value with any comment beside them", () => {
    expect(
      buildAskRoundAnswer(all, {
        pick: {
          selectedOptionIndexes: [],
          text: "only for a quarter",
          kit: { component: "choices", selected: [1] },
        },
        budget: { selectedOptionIndexes: [], text: "", kit: { component: "slider", value: 30 } },
        order: {
          selectedOptionIndexes: [],
          text: "",
          kit: { component: "ranking", order: [1, 0] },
        },
      }),
    ).toEqual({
      round: 3,
      answers: [
        { questionId: "pick", value: { plan: "team" }, comment: "only for a quarter" },
        { questionId: "budget", value: 30 },
        { questionId: "order", value: ["b", "a"] },
      ],
      deferredQuestionIds: [],
      problems: [],
    });
  });

  it("holds back a draft the question can't accept instead of dropping it", () => {
    const built = buildAskRoundAnswer(all, {
      budget: { selectedOptionIndexes: [], text: "", kit: { component: "slider", value: 35 } },
    });
    expect(built.answers).toEqual([]);
    expect(built.deferredQuestionIds).toEqual(["pick", "order"]);
    expect(built.problems.map(({ questionId, problem }) => [questionId, problem.code])).toEqual([
      ["budget", "answer-off-step"],
    ]);
  });

  it("turns the recommendation into the component's value only when asked", () => {
    const recommended = askKitRecommendation(choices);
    expect(recommended).toEqual({ component: "choices", selected: [1] });
    expect(sameAskKitValue({ selected: [1], component: "choices" }, recommended)).toBe(true);
    expect(sameAskKitValue(undefined, recommended)).toBe(false);
    expect(askKitRecommendation(slider)).toBeNull();
  });

  it("takes a custom view's answer only through the draft, with the person's comment", () => {
    const custom = { ...question("view"), surface: { kind: "html", html: "<form/>" } } as const;
    expect(
      buildAskRoundAnswer(round(custom), {
        view: { selectedOptionIndexes: [], text: "picked the blue one", html: { value: { c: 2 } } },
      }).answers,
    ).toEqual([{ questionId: "view", value: { c: 2 }, comment: "picked the blue one" }]);
  });

  it("keeps a null-valued option pickable on surfaces the kit doesn't own", () => {
    const native = {
      ...question("native"),
      recommendation: null,
      options: [{ label: "Skip", value: null }],
      surface: { kind: "kit", component: "native-question" },
    } satisfies SignalboxAskQuestion;
    expect(
      buildAskRoundAnswer(round(native), { native: { selectedOptionIndexes: [0], text: "" } })
        .answers,
    ).toEqual([{ questionId: "native", value: null }]);
  });
});
