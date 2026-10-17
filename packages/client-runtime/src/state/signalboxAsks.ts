import { ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";
import type { SignalboxAsk, SignalboxAskCommand } from "@t3tools/contracts/signalboxAsks";
import { pendingAskQuestions } from "@t3tools/shared/signalboxAsks";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createSignalboxAskCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcCommand<
    R,
    E,
    typeof ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
    SignalboxAskCommand
  >(runtime, {
    label: "signalbox-asks:dispatch",
    tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
  });
}

export interface AskDraftAnswer {
  readonly selectedOptionIndexes: ReadonlyArray<number>;
  readonly text: string;
  readonly useRecommendation?: boolean;
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

export function buildAskRoundAnswer(
  ask: SignalboxAsk,
  drafts: Readonly<Record<string, AskDraftAnswer>>,
) {
  const answers: Extract<SignalboxAskCommand, { type: "thread.ask.answer" }>["answers"][number][] =
    [];
  const deferredQuestionIds: string[] = [];
  for (const question of pendingAskQuestions(ask)) {
    const draft = drafts[question.id];
    const text = draft?.text.trim() ?? "";
    const selected = (draft?.selectedOptionIndexes ?? []).flatMap((index) =>
      question.options[index] ? [question.options[index].value] : [],
    );
    const value = draft?.useRecommendation
      ? question.recommendation
      : selected.length > 0
        ? question.multiSelect
          ? selected
          : selected[0]!
        : text || undefined;
    if (value === undefined) {
      deferredQuestionIds.push(question.id);
      continue;
    }
    answers.push({
      questionId: question.id,
      value,
      ...(text && (selected.length > 0 || draft?.useRecommendation) ? { comment: text } : {}),
    });
  }
  return { round: ask.rounds[ask.rounds.length - 1]!.number, answers, deferredQuestionIds };
}
