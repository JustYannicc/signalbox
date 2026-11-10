import { ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";
import type { AskKitProblem } from "@t3tools/contracts/askKit";
import type {
  SignalboxAsk,
  SignalboxAskCommand,
  SignalboxAskQuestion,
} from "@t3tools/contracts/signalboxAsks";
import { resolveAskKit } from "@t3tools/shared/askKit";
import {
  decodeAskKitAnswer,
  encodeAskKitAnswer,
  type AskKitValue,
} from "@t3tools/shared/askKitAnswer";
import { pendingAskQuestions } from "@t3tools/shared/signalboxAsks";
import * as Result from "effect/Result";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createSignalboxAskCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const command = createEnvironmentRpcCommand<
    R,
    E,
    typeof ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
    SignalboxAskCommand
  >(runtime, {
    label: "signalbox-asks:dispatch",
    tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
  });
  return {
    ...command,
    permissionAtom: (environmentId: Parameters<typeof command.permissionAtom>[0]) =>
      command.permissionAtom(environmentId, { type: "thread.ask.answer" }),
  };
}

export interface AskDraftAnswer {
  /** Options picked on a surface the kit doesn't own. */
  readonly selectedOptionIndexes: ReadonlyArray<number>;
  /** Free text: the comment beside a structured answer, or the whole answer without one. */
  readonly text: string;
  readonly useRecommendation?: boolean;
  /** A kit component's value once the person set it. Absent means untouched, so never sent. */
  readonly kit?: AskKitValue;
  /** The latest answer a custom HTML view sent. It only reaches the ask on Send. */
  readonly html?: { readonly value: unknown };
}

type AnswerInput = Extract<SignalboxAskCommand, { type: "thread.ask.answer" }>["answers"][number];

type AskDraftChange = { readonly [K in keyof AskDraftAnswer]?: AskDraftAnswer[K] | undefined };

/** Applies a change to a draft; a field changed to `undefined` is removed, so it isn't sent. */
export function updateAskDraft(draft: AskDraftAnswer, change: AskDraftChange): AskDraftAnswer {
  const pick = <K extends keyof AskDraftChange>(key: K) =>
    key in change ? change[key] : draft[key];
  const useRecommendation = pick("useRecommendation");
  const kit = pick("kit");
  const html = pick("html");
  return {
    selectedOptionIndexes: change.selectedOptionIndexes ?? draft.selectedOptionIndexes,
    text: change.text ?? draft.text,
    ...(useRecommendation === undefined ? {} : { useRecommendation }),
    ...(kit === undefined ? {} : { kit }),
    ...(html === undefined ? {} : { html }),
  };
}

/** The recommendation as a kit value, which "Use recommendation" sets like any other choice. */
export function askKitRecommendation(question: SignalboxAskQuestion): AskKitValue | null {
  if (question.recommendation === null) return null;
  const decoded = decodeAskKitAnswer(question, { value: question.recommendation });
  if (Result.isFailure(decoded)) return null;
  const { component } = decoded.success;
  return component === "legacy" || component === "words-only" ? null : decoded.success;
}

/** Normalized kit values hold only indexes, numbers and text, so sorted keys compare them. */
export function sameAskKitValue(a: AskKitValue | undefined, b: AskKitValue | null | undefined) {
  if (a === undefined || b === undefined || b === null) return false;
  return JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort());
}

function draftAnswer(
  question: SignalboxAskQuestion,
  draft: AskDraftAnswer | undefined,
): Omit<AnswerInput, "questionId"> | null {
  if (draft === undefined) return null;
  const text = draft.text.trim();
  if (resolveAskKit(question).spec.component !== "legacy") {
    // Whitespace typed into a text component is still untouched.
    const kit = draft.kit?.component === "text" && !draft.kit.text.trim() ? undefined : draft.kit;
    // Checked by decodeAskKitAnswer before it is sent, so the encoded value is JSON.
    if (kit !== undefined) {
      const value = encodeAskKitAnswer(question, kit) as AnswerInput["value"];
      return { value, ...(text ? { comment: text } : {}) };
    }
    return text ? { value: null, comment: text } : null;
  }
  if (draft.html !== undefined) {
    const value = draft.html.value as AnswerInput["value"];
    return { value, ...(text ? { comment: text } : {}) };
  }
  const selected = draft.selectedOptionIndexes.flatMap((index) =>
    question.options[index] ? [question.options[index].value] : [],
  );
  const value = draft.useRecommendation
    ? question.recommendation
    : selected.length > 0
      ? question.multiSelect
        ? selected
        : selected[0]!
      : text || undefined;
  if (value === undefined) return null;
  return {
    value,
    ...(text && (selected.length > 0 || draft.useRecommendation) ? { comment: text } : {}),
  };
}

/** Native questions keep their existing controls until the runtime can no longer accept an answer. */
export function visiblePendingAsks(
  asks: ReadonlyArray<SignalboxAsk>,
  requests: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly responseCapability: { readonly type: string };
  }>,
) {
  return asks.filter((ask) => {
    if (ask.status !== "pending" || pendingAskQuestions(ask).length === 0) return false;
    // Automation forms stay in their existing run panel until the common kit supports their fields.
    if (ask.source.kind === "automation") return false;
    if (ask.source.kind !== "native") return true;
    const requestId = ask.source.requestId;
    return !requests.some(
      (request) =>
        request.id === requestId &&
        request.status === "pending" &&
        request.responseCapability.type !== "not_resumable",
    );
  });
}

/**
 * The round's answers from the person's drafts. An untouched question is deferred; a draft the
 * question can't accept is held back in `problems`, so callers block Send instead of dropping it.
 */
export function buildAskRoundAnswer(
  ask: SignalboxAsk,
  drafts: Readonly<Record<string, AskDraftAnswer>>,
) {
  const answers: AnswerInput[] = [];
  const deferredQuestionIds: string[] = [];
  const problems: { readonly questionId: string; readonly problem: AskKitProblem }[] = [];
  for (const question of pendingAskQuestions(ask)) {
    const answer = draftAnswer(question, drafts[question.id]);
    if (answer === null) {
      deferredQuestionIds.push(question.id);
      continue;
    }
    const checked = decodeAskKitAnswer(question, answer);
    if (Result.isFailure(checked))
      problems.push({ questionId: question.id, problem: checked.failure });
    else answers.push({ questionId: question.id, ...answer });
  }
  return {
    round: ask.rounds[ask.rounds.length - 1]!.number,
    answers,
    deferredQuestionIds,
    problems,
  };
}
