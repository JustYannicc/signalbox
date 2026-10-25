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
import type { SignalboxAsk, SignalboxAskQuestion } from "@t3tools/contracts/signalboxAsks";
import { pendingAskQuestions } from "@t3tools/shared/signalboxAsks";
import { useId, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { readAccountSession } from "../../account/accountSession";
import { signalboxAskCommand } from "../../state/signalboxAsks";
import { useAutomationCommand } from "../automations/useAutomationCommand";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { SignalboxAskHistory } from "./SignalboxAskHistory";

const kindLabels = { blocker: "Blocker", ready: "Ready", considering: "Considering" };
const noAsks: ReadonlyArray<SignalboxAsk> = [];
const noRequests: ReadonlyArray<OrchestrationV2RuntimeRequest> = [];
const emptyDraft: AskDraftAnswer = { selectedOptionIndexes: [], text: "" };

function answerText(value: SignalboxAskQuestion["recommendation"]) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function AskQuestion({
  question,
  draft,
  disabled,
  onChange,
}: {
  question: SignalboxAskQuestion;
  draft: AskDraftAnswer;
  disabled: boolean;
  onChange: (draft: AskDraftAnswer) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-2 wrap-anywhere">
      <Label htmlFor={id}>{question.question}</Label>
      <dl className="space-y-1 text-xs text-muted-foreground">
        <div>
          <dt className="inline font-medium">Why: </dt>
          <dd className="inline">{question.why}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Unblocks: </dt>
          <dd className="inline">{question.unblocks}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Whose decision: </dt>
          <dd className="inline">{question.decisionOwner}</dd>
        </div>
        {question.recommendation === null ? null : (
          <div>
            <dt className="inline font-medium">Recommendation: </dt>
            <dd className="inline">{answerText(question.recommendation)}</dd>
          </div>
        )}
      </dl>
      <div className="flex flex-wrap gap-1.5">
        {question.options.map((option, index) => (
          <Button
            key={`${option.label}:${JSON.stringify(option.value)}`}
            type="button"
            size="sm"
            variant={draft.selectedOptionIndexes.includes(index) ? "secondary" : "outline"}
            aria-pressed={draft.selectedOptionIndexes.includes(index)}
            title={option.description}
            disabled={disabled}
            onClick={() =>
              onChange({
                ...draft,
                useRecommendation: false,
                selectedOptionIndexes: draft.selectedOptionIndexes.includes(index)
                  ? draft.selectedOptionIndexes.filter((selected) => selected !== index)
                  : question.multiSelect
                    ? [...draft.selectedOptionIndexes, index]
                    : [index],
              })
            }
          >
            {option.label}
          </Button>
        ))}
        {question.recommendation === null ? null : (
          <Button
            type="button"
            size="sm"
            variant={draft.useRecommendation ? "secondary" : "outline"}
            aria-pressed={draft.useRecommendation === true}
            disabled={disabled}
            onClick={() =>
              onChange({
                ...draft,
                selectedOptionIndexes: [],
                useRecommendation: !draft.useRecommendation,
              })
            }
          >
            Use recommendation
          </Button>
        )}
      </div>
      {question.surface.kind === "html" ? (
        <p className="text-xs text-muted-foreground">
          Answer with the options or text below. The custom view is unavailable here.
        </p>
      ) : null}
      <Textarea
        id={id}
        size="sm"
        aria-label={`Answer or comment: ${question.question}`}
        placeholder="Write an answer or add a comment"
        value={draft.text}
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, text: event.currentTarget.value })}
      />
    </div>
  );
}

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
  const submit = async (deferAll: boolean) => {
    if (disabled) return;
    const result = await command.run({
      environmentId: threadRef.environmentId,
      input: {
        type: "thread.ask.answer",
        commandId: CommandId.make(randomUUID()),
        threadId: threadRef.threadId,
        askId: ask.id,
        ...built,
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
          disabled={disabled}
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
          disabled={disabled || (built.answers.length === 0 && !comment.trim())}
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
                  {answerText(answer.value)}
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
