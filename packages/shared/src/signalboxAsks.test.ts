import { describe, expect, it } from "vitest";
import { CommandId, ThreadId } from "@t3tools/contracts";
import type {
  SignalboxAsk,
  SignalboxAskAnswerCommand,
  SignalboxAskCommand,
} from "@t3tools/contracts/signalboxAsks";
import { applyAskCommand, blockingAsk, pendingAskQuestions } from "./signalboxAsks.ts";

const now = "2026-10-16T10:00:00.000Z";
const target = {
  commandId: CommandId.make("ask:test"),
  threadId: ThreadId.make("thread:test"),
  askId: "ask:test",
};
const question = (id: string, blocking = false) => ({
  id,
  question: `Choose ${id}`,
  why: "We need the owner's preference",
  unblocks: "The next design choice",
  recommendation: "yes",
  options: [],
  blocking,
  decisionOwner: "Owner",
  surface: { kind: "kit" as const, component: "text" },
});
const raise: SignalboxAskCommand = {
  ...target,
  type: "thread.ask.raise",
  ask: {
    kind: "blocker",
    source: { kind: "agent" },
    questions: [question("a"), question("b", true), question("c")],
  },
};
function apply(asks: readonly SignalboxAsk[], command: SignalboxAskCommand) {
  const result = applyAskCommand(asks, command, now);
  if (!result.ok) throw new Error(result.error);
  return result;
}
const answer = (
  overrides: Partial<typeof SignalboxAskAnswerCommand.Type> = {},
): typeof SignalboxAskAnswerCommand.Type => ({
  ...target,
  type: "thread.ask.answer",
  round: 1,
  answers: [{ questionId: "a", value: "yes", comment: "Ship this" }],
  deferredQuestionIds: ["b"],
  answeredBy: { kind: "assistant", personId: "owner", assistantThreadId: target.threadId },
  comment: "Continue the independent work",
  ...overrides,
});

describe("durable ask rounds", () => {
  it("carries deferred and omitted questions, keeping readable evidence and answer provenance", () => {
    const result = apply(apply([], raise).asks, answer());
    const ask = result.asks[0]!;
    expect(ask.rounds[0]).toMatchObject({
      closedAt: now,
      deferredQuestionIds: ["b"],
      answers: [
        {
          questionId: "a",
          recommendationTaken: true,
          answeredBy: { kind: "assistant", personId: "owner" },
        },
      ],
    });
    expect(ask.rounds[1]).toMatchObject({ number: 2, questionIds: ["b", "c"], closedAt: null });
    expect(pendingAskQuestions(ask).map((question) => question.id)).toEqual(["b", "c"]);
    expect(blockingAsk(result.asks)?.id).toBe(ask.id);
    expect(result.answered?.message).toContain("Why: We need the owner's preference");
    expect(result.answered?.message).toContain("[a] Choose a");
    expect(result.answered?.message).toContain("Ship this");
    expect(result.answered?.message).toContain("Continue the independent work");
  });
  it("rejects stale rounds, duplicate IDs, unknown IDs and double answers", () => {
    const initial = apply([], raise).asks;
    const pending = apply(initial, answer()).asks;
    expect(applyAskCommand(pending, answer(), now).ok).toBe(false);
    expect(applyAskCommand(initial, answer({ deferredQuestionIds: ["a"] }), now).ok).toBe(false);
    expect(
      applyAskCommand(initial, answer({ answers: [{ questionId: "unknown", value: "yes" }] }), now)
        .ok,
    ).toBe(false);
    expect(
      applyAskCommand(
        initial,
        {
          ...raise,
          askId: "different",
          ask: { ...raise.ask, questions: [question("a"), question("a")] },
        },
        now,
      ).ok,
    ).toBe(false);
    const done = apply(
      pending,
      answer({
        round: 2,
        answers: [
          { questionId: "b", value: "no" },
          { questionId: "c", value: "yes" },
        ],
        deferredQuestionIds: [],
      }),
    ).asks;
    expect(done[0]?.status).toBe("answered");
    expect(applyAskCommand(done, answer({ round: 2 }), now).ok).toBe(false);
  });
  it("withdraws idempotently and non-blocking asks do not block work", () => {
    const asks = apply([], { ...raise, ask: { ...raise.ask, questions: [question("a")] } }).asks;
    expect(blockingAsk(asks)).toBeUndefined();
    const withdrawn = apply(asks, { ...target, type: "thread.ask.withdraw" }).asks;
    expect(pendingAskQuestions(withdrawn[0]!)).toEqual([]);
    expect(apply(withdrawn, { ...target, type: "thread.ask.withdraw" }).asks).toBe(withdrawn);
  });
  it("syncs only an automation's own record and retries idempotently", () => {
    const ask = {
      ...apply([], raise).asks[0]!,
      source: { kind: "automation" as const, runId: "run", stepKey: "gate" },
    };
    const command = { type: "thread.ask.sync" as const, ...target, ask };
    const asks = apply([], command).asks;
    expect(apply(asks, command).asks).toBe(asks);
    const answered = apply(
      asks,
      answer({
        answers: [
          { questionId: "a", value: "yes" },
          { questionId: "b", value: "yes" },
          { questionId: "c", value: "yes" },
        ],
        deferredQuestionIds: [],
      }),
    ).asks;
    expect(apply(answered, command).asks).toBe(answered);
    const deferred = apply(asks, answer()).asks;
    expect(apply(deferred, command).asks).toBe(deferred);
    const later = [{ ...ask, updatedAt: "2026-10-16T12:00:00.000Z" }];
    expect(apply(later, command).asks).toBe(later);
    expect(
      applyAskCommand(
        asks,
        { ...command, ask: { ...ask, source: { ...ask.source, runId: "other" } } },
        now,
      ).ok,
    ).toBe(false);
  });
});
