import { automationOptionLabel, parseAutomationAsk, type AutomationStep } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  askDraftValues,
  buildAskAnswer,
  initialAskDraft,
  questionFromStep,
  runQuestions,
} from "./ask.ts";

const { ask: replyAsk } = parseAutomationAsk({
  question: "Send this reply?",
  fields: {
    reply: { type: "longText", default: "Thanks!", required: true },
    count: { type: "number" },
    urgent: { type: "boolean" },
    tone: { type: "choice", options: ["warm", "formal"] },
  },
  options: ["send", "skip"],
});

const step = (overrides: Partial<AutomationStep>): AutomationStep => ({
  key: "s1",
  nodeId: "s1",
  verb: "ask",
  label: "Reply",
  status: "waiting",
  threadId: null,
  args: [{ question: "Pick some", options: ["a", "b"], multi: true }],
  result: null,
  error: null,
  errorDetail: null,
  attempt: 1,
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: null,
  ...overrides,
});

describe("questionFromStep", () => {
  it("offers approve and reject when the code names no options", () => {
    expect(questionFromStep("r", step({ args: [] }))?.options).toEqual(["approve", "reject"]);
    expect(questionFromStep("r", step({ args: [{ question: "  " }] }))?.question).toBeNull();
    expect(questionFromStep("r", step({ status: "succeeded" }))).toBeNull();
  });

  it("uses the code's options and shows a structured question as JSON", () => {
    const question = questionFromStep(
      "r",
      step({ args: [{ question: { to: "ana" }, options: ["send", "skip"] }] }),
    );
    expect(question?.options).toEqual(["send", "skip"]);
    expect(question?.question).toBe('{\n  "to": "ana"\n}');
  });
});

describe("ask form", () => {
  it("starts from the defaults, with numbers as text and booleans off", () => {
    expect(initialAskDraft(replyAsk.fields)).toEqual({
      reply: "Thanks!",
      count: "",
      urgent: false,
      tone: null,
    });
  });

  it("sends numbers as numbers, an empty number as null, and bad numbers as text", () => {
    const draft = { reply: "Hi", count: " 4.5 ", urgent: true, tone: "warm" };
    expect(askDraftValues(replyAsk.fields, draft)).toEqual({
      reply: "Hi",
      count: 4.5,
      urgent: true,
      tone: "warm",
    });
    expect(askDraftValues(replyAsk.fields, { ...draft, count: "  " }).count).toBeNull();
    expect(askDraftValues(replyAsk.fields, { ...draft, count: "4,5" }).count).toBe("4,5");
  });

  it("builds the payload for a picked option with the form's values", () => {
    const draft = { ...initialAskDraft(replyAsk.fields), reply: "Edited" };
    expect(buildAskAnswer(replyAsk, { choice: "send" }, draft)).toEqual({
      ok: true,
      input: {
        choice: "send",
        values: { reply: "Edited", count: null, urgent: false, tone: null },
      },
    });
  });

  it("says what's wrong before sending", () => {
    const draft = initialAskDraft(replyAsk.fields);
    expect(buildAskAnswer(replyAsk, { choice: "send" }, { ...draft, reply: "  " })).toEqual({
      ok: false,
      error: "Reply is required.",
    });
    expect(buildAskAnswer(replyAsk, { choice: "send" }, { ...draft, count: "lots" })).toEqual({
      ok: false,
      error: "Count must be a number.",
    });
  });

  it("sends a multi ask's picks as choices, with no values when there's no form", () => {
    const { ask } = parseAutomationAsk({ options: ["a", "b", "c"], multi: true });
    expect(buildAskAnswer(ask, { choices: ["c", "a"] }, {})).toEqual({
      ok: true,
      input: { choices: ["c", "a"] },
    });
    expect(buildAskAnswer(ask, { choices: [] }, {})).toEqual({ ok: true, input: { choices: [] } });
  });

  it("turns option identifiers into button words", () => {
    expect(automationOptionLabel("needs_changes")).toBe("Needs changes");
    expect(automationOptionLabel("approve")).toBe("Approve");
  });
});

describe("runQuestions", () => {
  it("fills in waiting ask steps the automation's waiting list hasn't caught up with", () => {
    const questions = runQuestions(
      "run-1",
      [step({}), step({ key: "s2", status: "succeeded" }), step({ key: "s3", verb: "sleep" })],
      [],
    );
    expect([...questions.keys()]).toEqual(["s1"]);
    expect(questions.get("s1")).toMatchObject({
      runId: "run-1",
      question: "Pick some",
      options: ["a", "b"],
      multi: true,
      fields: [],
    });
  });

  it("prefers the waiting list's question and ignores other runs'", () => {
    const listed = {
      runId: "run-1",
      stepKey: "s1",
      label: "Reply",
      question: "From the server",
      options: ["ok"],
      multi: false,
      fields: [],
      since: "2026-01-01T00:00:00.000Z",
    };
    const questions = runQuestions("run-1", [step({})], [listed, { ...listed, runId: "run-2" }]);
    expect(questions.get("s1")?.question).toBe("From the server");
    expect(questions.size).toBe(1);
  });
});
