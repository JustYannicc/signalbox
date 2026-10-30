import { useAtomValue } from "@effect/atom-react";
import {
  buildAskRoundAnswer,
  visiblePendingAsks,
  type AskDraftAnswer,
} from "@t3tools/client-runtime/state/signalboxAsks";
import {
  CommandId,
  type OrchestrationV2RuntimeRequest,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { SignalboxAsk } from "@t3tools/contracts/signalboxAsks";
import { pendingAskQuestions } from "@t3tools/shared/signalboxAsks";
import { useId, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { readAccountSession } from "../../account/accountSession";
import { signalboxAskCommand } from "../../state/signalboxAsks";
import { useAutomationCommand } from "../automations/useAutomationCommand";
import { AskQuestion, askValueText } from "../asks/AskQuestion";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { SignalboxAskHistory } from "./SignalboxAskHistory";

const kindLabels = { blocker: "Blocker", ready: "Ready", considering: "Considering" };
const noAsks: ReadonlyArray<SignalboxAsk> = [];
const noRequests: ReadonlyArray<OrchestrationV2RuntimeRequest> = [];
const emptyDraft: AskDraftAnswer = { selectedOptionIndexes: [], text: "" };

function AskRound({ ask, threadRef }: { ask: SignalboxAsk; threadRef: ScopedThreadRef }) {
  const canAnswer = useAtomValue(signalboxAskCommand.permissionAtom(threadRef.environmentId));
  const command = useAutomationCommand(
    signalboxAskCommand,
    "Couldn't save your answer. Try again.",
  );
  const [drafts, setDrafts] = useState<Record<string, AskDraftAnswer>>({});
  const [comment, setComment] = useState("");
  const commentId = useId();
  const pending = pendingAskQuestions(ask);
  const built = buildAskRoundAnswer(ask, drafts);
  const disabled = !canAnswer || command.busy;
  // A draft the question can't accept blocks Send, so nothing the person set is silently dropped.
  const blocked = built.problems.length > 0;
  const submit = async (deferAll: boolean) => {
    if (disabled) return;
    const result = await command.run({
      environmentId: threadRef.environmentId,
      input: {
        type: "thread.ask.answer",
        commandId: CommandId.make(randomUUID()),
        threadId: threadRef.threadId,
        askId: ask.id,
        round: built.round,
        answers: built.answers,
        deferredQuestionIds: built.deferredQuestionIds,
        ...(deferAll
          ? { answers: [], deferredQuestionIds: pending.map((question) => question.id) }
          : {}),
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        answeredBy: { kind: "person", personId: readAccountSession()?.account?.id ?? "local-user" },
      },
    });
    if (result) {
      setDrafts({});
      setComment("");
    }
  };
  return (
    <section
      aria-label={`${kindLabels[ask.kind]} round ${built.round}`}
      className="flex min-w-0 flex-col gap-4 p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <h3 className="font-medium">{kindLabels[ask.kind]}</h3>
        <span className="text-xs text-muted-foreground">
          Round {built.round} · {pending.length} remaining
        </span>
      </div>
      {pending.map((question) => (
        <AskQuestion
          key={question.id}
          question={question}
          draft={drafts[question.id] ?? emptyDraft}
          problem={built.problems.find((item) => item.questionId === question.id)?.problem}
          disabled={disabled}
          threadRef={threadRef}
          onChange={(draft) => setDrafts((current) => ({ ...current, [question.id]: draft }))}
        />
      ))}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={commentId}>Round comment (optional)</Label>
        <Textarea
          id={commentId}
          size="sm"
          value={comment}
          disabled={disabled}
          onChange={(event) => setComment(event.currentTarget.value)}
        />
      </div>
      {!canAnswer ? (
        <p className="text-xs text-muted-foreground">
          You don't have permission to answer in this environment.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={disabled || blocked || (built.answers.length === 0 && !comment.trim())}
          onClick={() => void submit(false)}
        >
          {command.busy
            ? "Saving…"
            : built.deferredQuestionIds.length > 0
              ? "Save answers, defer remainder"
              : "Save answers"}
        </Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => void submit(true)}>
          Defer all
        </Button>
      </div>
      {ask.rounds.length > 1 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Previous rounds</summary>
          {ask.rounds.slice(0, -1).map((round) => (
            <div key={round.number} className="mt-2 space-y-1 wrap-anywhere">
              <p className="font-medium">Round {round.number}</p>
              {round.answers.map((answer) => (
                <p key={answer.questionId}>
                  {ask.questions.find((question) => question.id === answer.questionId)?.question}:{" "}
                  {askValueText(answer.value)}
                  {answer.comment ? ` · ${answer.comment}` : ""}
                </p>
              ))}
              {round.comment ? <p>{round.comment}</p> : null}
              {round.deferredQuestionIds.length > 0 ? (
                <p>{round.deferredQuestionIds.length} deferred</p>
              ) : null}
            </div>
          ))}
        </details>
      ) : null}
    </section>
  );
}

export function SignalboxAsksPanel({
  asks = noAsks,
  requests = noRequests,
  threadRef,
}: {
  asks: ReadonlyArray<SignalboxAsk> | undefined;
  requests: ReadonlyArray<OrchestrationV2RuntimeRequest> | undefined;
  threadRef: ScopedThreadRef;
}) {
  const visible = visiblePendingAsks(asks, requests);
  const history = asks.filter((ask) => ask.status !== "pending");
  if (visible.length === 0 && history.length === 0) return null;
  return (
    <div className="max-h-96 overflow-y-auto divide-y divide-border border-b border-border bg-background">
      {visible.map((ask) => (
        <AskRound
          key={`${threadRef.environmentId}:${threadRef.threadId}:${ask.id}:${ask.rounds[ask.rounds.length - 1]!.number}`}
          ask={ask}
          threadRef={threadRef}
        />
      ))}
      <SignalboxAskHistory asks={history} />
    </div>
  );
}
