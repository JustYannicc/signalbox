import * as Array from "effect/Array";
import type { OrchestrationV2Command } from "@t3tools/contracts";
import type {
  SignalboxAsk,
  SignalboxAskAnswerInput,
  SignalboxAskServerCommand,
} from "@t3tools/contracts/signalboxAsks";
import type {
  SignalboxAskConsidering,
  SignalboxAskConsideringFireProof,
  SignalboxAskConsideringFired,
  SignalboxAskConsideringProof,
} from "@t3tools/contracts/signalboxConsidering";

export function pendingAskQuestions(ask: SignalboxAsk) {
  if (ask.status !== "pending") return [];
  const round = ask.rounds.at(-1);
  return ask.questions.filter((question) => round?.questionIds.includes(question.id));
}

export function blockingAsk(asks: readonly SignalboxAsk[] | undefined) {
  return asks?.find(
    (ask) =>
      ask.kind === "blocker" && pendingAskQuestions(ask).some((question) => question.blocking),
  );
}

/** A fired Considering exit is eligible for the pipeline; other ask kinds use their own rules. */
export function consideringAskHasFiredExit(ask: SignalboxAsk) {
  return (
    ask.kind === "considering" && ask.status === "pending" && ask.considering?.fired !== undefined
  );
}

const WEEKLY_REVIEW_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const instant = (value: string) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

function eventWhereMatches(
  where: Readonly<Record<string, unknown>> | undefined,
  proof: Extract<SignalboxAskConsideringFireProof, { kind: "event" }>,
) {
  if (where === undefined) return true;
  return Object.entries(where).every(([field, expected]) => {
    const actual = field === "event" ? proof.name : proof.matchedFields[field];
    if (field !== "event" && !Object.hasOwn(proof.matchedFields, field)) return false;
    const githubRepository = field === "repository" && /^(pr|release|issue)\./.test(proof.name);
    const canonical = (value: unknown) =>
      githubRepository && typeof value === "string" ? value.toLowerCase() : value;
    const canonicalActual = canonical(actual);
    return Array.isArray(expected)
      ? expected.some((value) => canonical(value) === canonicalActual)
      : canonical(expected) === canonicalActual;
  });
}

function consideringFireProofMatches(
  considering: SignalboxAskConsidering,
  proof: SignalboxAskConsideringFireProof,
  now: string,
) {
  const nowMs = instant(now);
  if (nowMs === undefined) return false;
  const exit = considering.exit;
  switch (proof.kind) {
    case "date": {
      const dueAt = instant(exit.kind === "date" ? exit.at : "");
      return dueAt !== undefined && instant(proof.at) === dueAt && nowMs >= dueAt;
    }
    case "event":
      return (
        exit.kind === "event" && proof.name === exit.name && eventWhereMatches(exit.where, proof)
      );
    case "evidence":
      return exit.kind === "evidence" && exit.sourceKinds.includes(proof.source);
    case "weekly-review": {
      const revisionAt = instant(considering.revisionAt);
      const staleSince = instant(proof.staleSince);
      const reviewedAt = instant(proof.reviewedAt);
      return (
        revisionAt !== undefined &&
        staleSince === revisionAt &&
        reviewedAt !== undefined &&
        reviewedAt - staleSince >= WEEKLY_REVIEW_AGE_MS &&
        nowMs >= reviewedAt
      );
    }
  }
}

function consideringProofWhatChanged(proof: SignalboxAskConsideringProof) {
  switch (proof.kind) {
    case "date":
      return `Date exit reached at ${proof.at}.`;
    case "event": {
      const matched = Object.entries(proof.matchedFields)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([field, value]) => `${field}=${JSON.stringify(value)}`)
        .join(", ");
      return `Event "${proof.name}" matched${matched ? ` (${matched})` : ""}.`;
    }
    case "evidence":
      return `Evidence item ${proof.eventId} from ${proof.source} materially changed this decision.`;
    case "weekly-review":
      return `Weekly review at ${proof.reviewedAt} found this exit open since ${proof.staleSince}.`;
    case "owner":
      return proof.whatChanged;
  }
}

function consideringFired(
  at: string,
  proof: SignalboxAskConsideringProof,
): SignalboxAskConsideringFired {
  const whatChanged = consideringProofWhatChanged(proof);
  switch (proof.kind) {
    case "date":
      return { at, source: "date", whatChanged, proof };
    case "event":
      return { at, source: "event", whatChanged, proof };
    case "evidence":
      return { at, source: "evidence", whatChanged, proof };
    case "weekly-review":
      return { at, source: "weekly-review", whatChanged, proof };
    case "owner":
      return { at, source: "owner", whatChanged, proof };
  }
}

function updateConsideringAsk(
  asks: readonly SignalboxAsk[],
  ask: SignalboxAsk,
  considering: SignalboxAskConsidering,
  now: string,
): AskResult {
  const updated: SignalboxAsk = { ...ask, considering, updatedAt: now };
  return {
    ok: true,
    asks: asks.map((entry) => (entry.id === ask.id ? updated : entry)),
  };
}

/** Older shells without a linked ask retain their native waiting state. */
export function runtimeRequestNeedsInput(
  request: { readonly id: string; readonly kind: string } | null,
  asks: readonly SignalboxAsk[] | undefined,
) {
  if (request?.kind !== "user_input") return false;
  const linked = asks?.find(
    (ask) => ask.source.kind === "native" && ask.source.requestId === request.id,
  );
  return linked === undefined || pendingAskQuestions(linked).some((question) => question.blocking);
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null)
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    );
  const a = Object.entries(left);
  const b = Object.entries(right);
  return (
    a.length === b.length &&
    a.every(([key, value]) => Object.hasOwn(right, key) && sameJson(value, Reflect.get(right, key)))
  );
}

function answerText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

type AskResult =
  | {
      ok: true;
      asks: readonly SignalboxAsk[];
      answered?: {
        ask: SignalboxAsk;
        message: string;
        answers: readonly (typeof SignalboxAskAnswerInput.Type)[];
      };
    }
  | { ok: false; error: string };

export function applyAskCommand(
  asks: readonly SignalboxAsk[],
  command: SignalboxAskServerCommand,
  now: string,
): AskResult {
  if (command.type === "thread.ask.sync") {
    const incoming = command.ask;
    const previous = asks.find((entry) => entry.id === incoming.id);
    if (
      incoming.source.kind !== "automation" ||
      (previous &&
        (previous.source.kind !== "automation" ||
          previous.source.runId !== incoming.source.runId ||
          previous.source.stepKey !== incoming.source.stepKey))
    )
      return { ok: false, error: "Only the owning automation can sync this ask." };
    if (incoming.considering !== undefined || previous?.considering !== undefined)
      return { ok: false, error: "Automation asks do not own Considering exits." };
    if (
      new Set(incoming.questions.map((question) => question.id)).size !== incoming.questions.length
    )
      return { ok: false, error: "Question IDs must be unique within an ask." };
    if (
      previous &&
      (previous.rounds.length > incoming.rounds.length ||
        (previous.rounds.length === incoming.rounds.length &&
          previous.status !== "pending" &&
          incoming.status === "pending") ||
        Date.parse(previous.updatedAt) > Date.parse(incoming.updatedAt) ||
        sameJson(previous, incoming))
    )
      return { ok: true, asks };
    return {
      ok: true,
      asks: previous
        ? asks.map((entry) => (entry.id === incoming.id ? incoming : entry))
        : [...asks, incoming],
    };
  }
  const ask = asks.find((candidate) => candidate.id === command.askId);
  if (command.type === "thread.ask.raise") {
    if (ask) return { ok: false, error: "An ask with this ID already exists." };
    const ids = command.ask.questions.map((question) => question.id);
    if (new Set(ids).size !== ids.length)
      return { ok: false, error: "Question IDs must be unique within an ask." };
    const fields = {
      id: command.askId,
      status: "pending" as const,
      createdAt: now,
      updatedAt: now,
      rounds: [
        {
          number: 1,
          questionIds: ids,
          answers: [],
          deferredQuestionIds: [],
          openedAt: now,
          closedAt: null,
        },
      ] as const,
    };
    const raised: SignalboxAsk =
      command.ask.kind === "considering" &&
      "considering" in command.ask &&
      command.ask.considering !== undefined
        ? {
            ...command.ask,
            ...fields,
            considering: { ...command.ask.considering, revision: 1, revisionAt: now },
          }
        : {
            kind: command.ask.kind,
            questions: command.ask.questions,
            source: command.ask.source,
            ...fields,
          };
    return { ok: true, asks: [...asks, raised] };
  }
  if (!ask) return { ok: false, error: "The ask was not found." };
  if (
    command.type === "thread.ask.considering.fire" ||
    command.type === "thread.ask.considering.resume" ||
    command.type === "thread.ask.considering.redefer"
  ) {
    if (ask.source.kind !== "agent")
      return { ok: false, error: "This ask source owns its Considering lifecycle." };
    if (ask.status !== "pending" || ask.kind !== "considering")
      return { ok: false, error: "This Considering ask is no longer active." };
    const current = ask.considering;
    if (current === undefined) {
      if (command.type !== "thread.ask.considering.redefer" || command.expectedRevision !== null)
        return { ok: false, error: "Set an exit condition before resuming this older ask." };
      const considering = { ...command.considering, revision: 1, revisionAt: now };
      return updateConsideringAsk(asks, ask, considering, now);
    }
    if (command.expectedRevision === null || current.revision !== command.expectedRevision)
      return { ok: false, error: "This Considering exit changed. Reload before continuing." };
    if (command.type === "thread.ask.considering.redefer") {
      const considering = {
        ...command.considering,
        revision: current.revision + 1,
        revisionAt: now,
      };
      return updateConsideringAsk(asks, ask, considering, now);
    }
    if (current.fired !== undefined) return { ok: true, asks };
    const proof =
      command.type === "thread.ask.considering.resume"
        ? { kind: "owner" as const, whatChanged: command.whatChanged }
        : command.proof;
    if (
      command.type === "thread.ask.considering.fire" &&
      !consideringFireProofMatches(current, command.proof, now)
    )
      return { ok: false, error: "This proof does not satisfy the current exit condition." };
    const fired = consideringFired(now, proof);
    const considering = { ...current, fired };
    return updateConsideringAsk(asks, ask, considering, now);
  }
  if (command.type === "thread.ask.withdraw") {
    if (ask.status !== "pending") return { ok: true, asks };
    return {
      ok: true,
      asks: asks.map((entry) =>
        entry.id !== ask.id
          ? entry
          : {
              ...entry,
              status: "withdrawn",
              updatedAt: now,
              rounds: Array.map(entry.rounds, (round) =>
                round.closedAt === null ? { ...round, closedAt: now } : round,
              ),
            },
      ),
    };
  }
  if (ask.status !== "pending") return { ok: false, error: "This ask is no longer pending." };
  const round = ask.rounds.at(-1)!;
  if (round.number !== command.round || round.closedAt !== null)
    return { ok: false, error: "This ask round has changed. Reload before answering." };
  const answerIds = command.answers.map((answer) => answer.questionId);
  const deferred = command.deferredQuestionIds;
  if (new Set([...answerIds, ...deferred]).size !== answerIds.length + deferred.length)
    return { ok: false, error: "A question cannot be answered or deferred more than once." };
  if ([...answerIds, ...deferred].some((id) => !round.questionIds.includes(id)))
    return { ok: false, error: "Answer and defer IDs must belong to the current round." };
  if (!answerIds.length && !deferred.length && !command.comment?.trim())
    return { ok: false, error: "Answer, defer a question, or leave a comment before sending." };
  const remaining = round.questionIds.filter((id) => !answerIds.includes(id));
  const closed = {
    ...round,
    closedAt: now,
    deferredQuestionIds: deferred,
    ...(command.comment === undefined ? {} : { comment: command.comment }),
    answers: command.answers.map((answer) => ({
      ...answer,
      answeredBy: command.answeredBy,
      answeredAt: now,
      recommendationTaken: sameJson(
        ask.questions.find((q) => q.id === answer.questionId)?.recommendation,
        answer.value,
      ),
    })),
  };
  const rounds = [
    ...ask.rounds.slice(0, -1),
    closed,
    ...(remaining.length
      ? [
          {
            number: round.number + 1,
            questionIds: remaining,
            answers: [],
            deferredQuestionIds: [],
            openedAt: now,
            closedAt: null,
          },
        ]
      : []),
  ];
  const updated: SignalboxAsk = {
    ...ask,
    status: remaining.length ? "pending" : "answered",
    updatedAt: now,
    rounds: [rounds[0]!, ...rounds.slice(1)],
  };
  const lines = [`Answer to ${ask.kind} ask ${ask.id}, round ${round.number}.`];
  for (const answer of command.answers) {
    const question = ask.questions.find((q) => q.id === answer.questionId)!;
    lines.push(
      `[${question.id}] ${question.question}\nWhy: ${question.why}\nUnblocks: ${question.unblocks}\nAnswer: ${answerText(answer.value)}${answer.comment ? `\nComment: ${answer.comment}` : ""}`,
    );
  }
  if (remaining.length) lines.push(`Still pending: ${remaining.join(", ")}.`);
  if (command.comment?.trim()) lines.push(`Comment: ${command.comment}`);
  return {
    ok: true,
    asks: asks.map((entry) => (entry.id === ask.id ? updated : entry)),
    answered: { ask: updated, answers: command.answers, message: lines.join("\n\n") },
  };
}

/** A client can answer as itself; native and workflow provenance comes from internal paths. */
export function clientAskCommand(
  command: OrchestrationV2Command,
  personId: string,
): OrchestrationV2Command {
  switch (command.type) {
    case "thread.ask.raise":
      return { ...command, ask: { ...command.ask, source: { kind: "agent" } } };
    case "thread.ask.answer":
      return { ...command, answeredBy: { kind: "person", personId } };
    default:
      return command;
  }
}

export { compactAskEvents, threadWithAsk } from "./signalboxAskEvents.ts";

/** A dead native callback never received the held rounds, so resume with their full context. */
export function nativeAskAnswerMessage(ask: SignalboxAsk) {
  const lines = [`Answers to ${ask.kind} ask ${ask.id}.`];
  for (const round of ask.rounds) {
    if (!round.answers.length && !round.comment?.trim()) continue;
    lines.push(`Round ${round.number}:`);
    for (const answer of round.answers) {
      const question = ask.questions.find((entry) => entry.id === answer.questionId);
      if (!question) continue;
      lines.push(
        `[${question.id}] ${question.question}\nWhy: ${question.why}\nUnblocks: ${question.unblocks}\nAnswer: ${answerText(answer.value)}${answer.comment ? `\nComment: ${answer.comment}` : ""}`,
      );
    }
    if (round.comment?.trim()) lines.push(`Comment: ${round.comment}`);
  }
  const pending = pendingAskQuestions(ask);
  if (pending.length)
    lines.push(`Still pending: ${pending.map((question) => question.id).join(", ")}.`);
  return lines.join("\n\n");
}
