import { describe, expect, it } from "vite-plus/test";
import { CommandId, ProjectId, ThreadId, RuntimeRequestId } from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import type {
  SignalboxAsk,
  SignalboxAskAnswerCommand,
  SignalboxAskCommand,
  SignalboxAskServerCommand,
} from "@t3tools/contracts/signalboxAsks";
import type {
  SignalboxAskConsideringExit,
  SignalboxAskConsideringFireProof,
} from "@t3tools/contracts/signalboxConsidering";
import {
  applyAskCommand,
  blockingAsk,
  consideringAskHasFiredExit,
  pendingAskQuestions,
  clientAskCommand,
} from "./signalboxAsks.ts";

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
const consideringRaise: SignalboxAskCommand = {
  ...target,
  type: "thread.ask.raise",
  ask: {
    kind: "considering",
    source: { kind: "agent" },
    questions: [question("decision")],
    considering: {
      exit: { kind: "event", name: "The customer replies" },
      preparationAttachmentIds: [],
    },
  },
};
const consideringRaiseWithExit = (exit: SignalboxAskConsideringExit) => ({
  ...target,
  type: "thread.ask.raise" as const,
  ask: {
    kind: "considering" as const,
    source: { kind: "agent" as const },
    questions: [question("decision")],
    considering: { exit, preparationAttachmentIds: [] },
  },
});
const defaultFireProof: SignalboxAskConsideringFireProof = {
  kind: "event",
  eventId: "event:customer-replied",
  name: "The customer replies",
  matchedFields: {},
};
const fire = (
  expectedRevision = 1,
  proof: SignalboxAskConsideringFireProof = defaultFireProof,
) => ({
  ...target,
  type: "thread.ask.considering.fire" as const,
  expectedRevision,
  proof,
  expectedHome: {
    kind: "cloud" as const,
    projectId: ProjectId.make("project:test"),
    contextId: SignalboxContextId.make("context:test"),
    driveId: "drive:test",
  },
});
const redefer = (expectedRevision: number | null, name: string) => ({
  ...target,
  type: "thread.ask.considering.redefer" as const,
  expectedRevision,
  considering: {
    exit: { kind: "event" as const, name },
    preparationAttachmentIds: [],
  },
});
function applyAt(asks: readonly SignalboxAsk[], command: SignalboxAskServerCommand, at = now) {
  const result = applyAskCommand(asks, command, at);
  if (!result.ok) throw new Error(result.error);
  return result;
}
const apply = (asks: readonly SignalboxAsk[], command: SignalboxAskServerCommand) =>
  applyAt(asks, command);
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
    const automationConsidering = {
      ...ask,
      kind: "considering" as const,
      considering: {
        exit: { kind: "event" as const, name: "event" },
        preparationAttachmentIds: [],
        revision: 1,
        revisionAt: now,
      },
    };
    expect(applyAskCommand(asks, { ...command, ask: automationConsidering }, now).ok).toBe(false);
  });
});

describe("Considering lifecycle", () => {
  it("fires once per revision, re-defers with a new revision, and supports owner resume", () => {
    const raised = apply([], consideringRaise).asks;
    expect(raised[0]?.considering).toMatchObject({
      revision: 1,
      revisionAt: now,
      fired: undefined,
    });
    const fired = apply(raised, fire()).asks;
    expect(fired[0]?.considering?.fired).toEqual({
      at: now,
      source: "event",
      whatChanged: 'Event "The customer replies" matched.',
      proof: defaultFireProof,
    });
    expect(consideringAskHasFiredExit(fired[0]!)).toBe(true);
    expect(applyAskCommand(fired, fire(), now)).toMatchObject({ ok: true, asks: fired });
    expect(applyAskCommand(raised, fire(2), now).ok).toBe(false);

    const deferred = apply(fired, redefer(1, "The budget is approved")).asks;
    expect(deferred[0]?.considering).toMatchObject({
      revision: 2,
      exit: { kind: "event", name: "The budget is approved" },
    });
    expect(deferred[0]?.considering?.fired).toBeUndefined();
    expect(consideringAskHasFiredExit(deferred[0]!)).toBe(false);
    expect(applyAskCommand(deferred, fire(1), now).ok).toBe(false);

    const resumed = apply(deferred, {
      ...target,
      type: "thread.ask.considering.resume",
      expectedRevision: 2,
      whatChanged: "I have had enough time to decide.",
    }).asks;
    expect(resumed[0]?.considering?.fired).toMatchObject({
      source: "owner",
      whatChanged: "I have had enough time to decide.",
      proof: { kind: "owner", whatChanged: "I have had enough time to decide." },
    });
    expect(consideringAskHasFiredExit(resumed[0]!)).toBe(true);
  });

  it("lets a legacy Considering ask acquire its first exit only with a null revision", () => {
    const saved = apply([], consideringRaise).asks[0]!;
    const legacy = { ...saved, considering: undefined } as SignalboxAsk;
    expect(applyAskCommand([legacy], redefer(null, "A date arrives"), now)).toMatchObject({
      ok: true,
      asks: [{ considering: { revision: 1, revisionAt: now, exit: { name: "A date arrives" } } }],
    });
    expect(applyAskCommand([legacy], redefer(1, "A date arrives"), now).ok).toBe(false);
  });

  it("matches date and event proofs against the saved exit", () => {
    const dated = apply(
      [],
      consideringRaiseWithExit({ kind: "date", at: "2026-10-16T09:00:00.000Z" }),
    ).asks;
    expect(
      applyAskCommand(dated, fire(1, { kind: "date", at: "2026-10-16T09:00:00.000Z" }), now).ok,
    ).toBe(true);
    expect(
      applyAskCommand(dated, fire(1, { kind: "date", at: "2026-10-16T11:00:00.000Z" }), now).ok,
    ).toBe(false);
    expect(
      applyAskCommand(
        dated,
        fire(1, { kind: "date", at: "2026-10-16T09:00:00.000Z" }),
        "2026-10-16T08:59:59.999Z",
      ).ok,
    ).toBe(false);

    const eventAsk = apply(
      [],
      consideringRaiseWithExit({
        kind: "event",
        name: "pr.closed",
        where: {
          event: "pr.closed",
          repository: ["JustYannicc/Signalbox", "Other/Repo"],
          state: ["closed", "merged"],
        },
      }),
    ).asks;
    const matchingProof: SignalboxAskConsideringFireProof = {
      kind: "event",
      eventId: "event:pr-closed",
      name: "pr.closed",
      matchedFields: { repository: "JustYannicc/Signalbox", state: "closed" },
    };
    expect(applyAskCommand(eventAsk, fire(1, matchingProof), now).ok).toBe(true);
    expect(
      applyAskCommand(
        eventAsk,
        fire(1, {
          ...matchingProof,
          matchedFields: { repository: "other/repo", state: "closed" },
        }),
        now,
      ).ok,
    ).toBe(false);
    expect(
      applyAskCommand(eventAsk, fire(1, { ...matchingProof, name: "pr.opened" }), now).ok,
    ).toBe(false);
    expect(
      applyAskCommand(
        eventAsk,
        fire(1, { ...matchingProof, matchedFields: { repository: "JustYannicc/Signalbox" } }),
        now,
      ).ok,
    ).toBe(false);
  });

  it("checks evidence sources and the current revision age for weekly review", () => {
    const evidenceAsk = apply(
      [],
      consideringRaiseWithExit({
        kind: "evidence",
        reference: "support case 42",
        relatednessCriteria: "The item concerns this customer's case.",
        materialChangeCriteria: "It changes the decision about the chosen option.",
        sourceKinds: ["message.sent"],
      }),
    ).asks;
    const evidenceProof: SignalboxAskConsideringFireProof = {
      kind: "evidence",
      source: "message.sent",
      eventId: "event:message-42",
      judgment: "materially_changes",
    };
    expect(applyAskCommand(evidenceAsk, fire(1, evidenceProof), now).ok).toBe(true);
    expect(
      applyAskCommand(evidenceAsk, fire(1, { ...evidenceProof, source: "drive.changed" }), now).ok,
    ).toBe(false);

    const raised = apply([], consideringRaise).asks;
    const weeklyProof: SignalboxAskConsideringFireProof = {
      kind: "weekly-review",
      reviewedAt: "2026-10-23T10:00:00.000Z",
      staleSince: now,
      automationRunId: "run:weekly-review",
    };
    expect(
      applyAt(raised, fire(1, weeklyProof), "2026-10-23T10:00:00.000Z").asks[0]?.considering?.fired,
    ).toMatchObject({ source: "weekly-review", proof: weeklyProof });
    expect(
      applyAskCommand(
        raised,
        fire(1, { ...weeklyProof, staleSince: "2026-10-15T10:00:00.000Z" }),
        "2026-10-23T10:00:00.000Z",
      ).ok,
    ).toBe(false);
    expect(applyAskCommand(raised, fire(1, weeklyProof), "2026-10-22T23:59:59.999Z").ok).toBe(
      false,
    );
  });

  it("does not resurrect exits after an ask is answered or withdrawn", () => {
    const fired = apply(apply([], consideringRaise).asks, fire()).asks;
    const answered = apply(
      fired,
      answer({
        answers: [{ questionId: "decision", value: "yes" }],
        deferredQuestionIds: [],
      }),
    ).asks[0]!;
    expect(answered.status).toBe("answered");
    expect(consideringAskHasFiredExit(answered)).toBe(false);
    expect(applyAskCommand([answered], fire(), now).ok).toBe(false);

    const withdrawn = apply(fired, { ...target, type: "thread.ask.withdraw" }).asks[0]!;
    expect(withdrawn.status).toBe("withdrawn");
    expect(consideringAskHasFiredExit(withdrawn)).toBe(false);
    expect(applyAskCommand([withdrawn], redefer(1, "Another event"), now).ok).toBe(false);
  });

  it("rejects lifecycle commands on automation and native asks", () => {
    const saved = apply([], consideringRaise).asks[0]!;
    const automation = {
      ...saved,
      source: { kind: "automation" as const, runId: "run", stepKey: "step" },
    };
    const native = {
      ...saved,
      source: { kind: "native" as const, requestId: RuntimeRequestId.make("request") },
    };
    for (const ask of [automation, native]) {
      expect(applyAskCommand([ask], fire(), now).ok).toBe(false);
      expect(applyAskCommand([ask], redefer(1, "A new event"), now).ok).toBe(false);
    }
  });
});

it("attributes public answers to the caller and prevents reserved source forgery", () => {
  const forged = clientAskCommand(
    answer({
      answeredBy: { kind: "assistant", personId: "victim", assistantThreadId: target.threadId },
    }),
    "signed-in",
  );
  expect(forged).toMatchObject({ answeredBy: { kind: "person", personId: "signed-in" } });
  expect(clientAskCommand(raise, "signed-in")).toMatchObject({
    ask: { source: { kind: "agent" } },
  });
});
