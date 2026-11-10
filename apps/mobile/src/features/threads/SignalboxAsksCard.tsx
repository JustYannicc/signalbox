import { useAtomValue } from "@effect/atom-react";
import {
  buildAskRoundAnswer,
  visiblePendingAsks,
  type AskDraftAnswer,
} from "@t3tools/client-runtime/state/signalboxAsks";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CommandId, type ScopedThreadRef } from "@t3tools/contracts";
import type { SignalboxAsk } from "@t3tools/contracts/signalboxAsks";
import { pendingAskQuestions } from "@t3tools/shared/signalboxAsks";
import { useRef, useState } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { uuidv4 } from "../../lib/uuid";
import { signalboxAskCommand } from "../../state/signalboxAsks";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadProjection } from "../../state/use-thread-detail";
import { AskQuestion } from "../asks/AskQuestion";
import { RequestActionButton } from "./RequestActionButton";
import { SignalboxAskHistory } from "./SignalboxAskHistory";

const kindLabels = { blocker: "Blocker", ready: "Ready", considering: "Considering" };
const noAsks: ReadonlyArray<SignalboxAsk> = [];
const emptyDraft: AskDraftAnswer = { selectedOptionIndexes: [], text: "" };

function AskRound(props: {
  readonly ask: SignalboxAsk;
  readonly threadRef: ScopedThreadRef;
  readonly onInputFocusChange: (focused: boolean) => void;
}) {
  const { ask, threadRef } = props;
  const canAnswer = useAtomValue(signalboxAskCommand.permissionAtom(threadRef.environmentId));
  const send = useAtomCommand(signalboxAskCommand, { reportFailure: false });
  const [drafts, setDrafts] = useState<Record<string, AskDraftAnswer>>({});
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const built = buildAskRoundAnswer(ask, drafts);
  const questions = pendingAskQuestions(ask);
  const disabled = !canAnswer || busy;
  // A draft the question can't accept blocks Send, so nothing the person set is silently dropped.
  const blocked = built.problems.length > 0;
  const submit = async (deferAll: boolean) => {
    if (
      disabled ||
      inFlight.current ||
      (!deferAll && (blocked || (built.answers.length === 0 && !comment.trim())))
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await send({
        environmentId: threadRef.environmentId,
        input: {
          type: "thread.ask.answer",
          commandId: CommandId.make(uuidv4()),
          threadId: threadRef.threadId,
          askId: ask.id,
          round: built.round,
          answers: built.answers,
          deferredQuestionIds: built.deferredQuestionIds,
          ...(comment.trim() ? { comment: comment.trim() } : {}),
          ...(deferAll
            ? { answers: [], deferredQuestionIds: questions.map((question) => question.id) }
            : {}),
          answeredBy: { kind: "person", personId: "local-user" },
        },
      });
      if (result._tag === "Success") {
        setDrafts({});
        setComment("");
      } else if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Couldn't save your answer. Try again.");
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <View className="gap-3 p-4">
      <Text accessibilityRole="header" className="font-t3-bold text-base text-foreground">
        {kindLabels[ask.kind]} · Round {built.round}
      </Text>
      {questions.map((question) => (
        <AskQuestion
          key={question.id}
          question={question}
          draft={drafts[question.id] ?? emptyDraft}
          problem={built.problems.find((item) => item.questionId === question.id)?.problem}
          disabled={disabled}
          environmentId={threadRef.environmentId}
          onInputFocusChange={props.onInputFocusChange}
          onChange={(draft) => setDrafts((current) => ({ ...current, [question.id]: draft }))}
        />
      ))}
      <TextInput
        accessibilityLabel="Round comment (optional)"
        placeholder="Round comment (optional)"
        multiline
        value={comment}
        editable={!disabled}
        onChangeText={setComment}
        onFocus={() => props.onInputFocusChange(true)}
        onBlur={() => props.onInputFocusChange(false)}
      />
      {!canAnswer ? (
        <Text className="font-sans text-sm text-foreground-muted">
          You don't have permission to answer in this environment.
        </Text>
      ) : null}
      {error ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {error}
        </Text>
      ) : null}
      <RequestActionButton
        label={
          busy
            ? "Saving…"
            : built.deferredQuestionIds.length > 0
              ? "Save answers, defer remainder"
              : "Save answers"
        }
        disabled={disabled || blocked || (built.answers.length === 0 && !comment.trim())}
        onPress={() => void submit(false)}
      />
      <RequestActionButton
        label="Defer all"
        tone="secondary"
        disabled={disabled}
        onPress={() => void submit(true)}
      />
    </View>
  );
}

export function SignalboxAsksCard(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly maxHeight: number;
  readonly onInputFocusChange: (focused: boolean) => void;
}) {
  const thread = useThreadProjection({
    environmentId: props.threadRef?.environmentId ?? null,
    threadId: props.threadRef?.threadId ?? null,
  });
  const projection = thread?.projection;
  const allAsks = projection?.thread.asks ?? noAsks;
  const asks = visiblePendingAsks(allAsks, projection?.runtimeRequests ?? []);
  const history = allAsks.filter((ask) => ask.status !== "pending");
  const threadRef = props.threadRef;
  if (threadRef === null || (asks.length === 0 && history.length === 0)) return null;
  return (
    <View className="mx-4 mb-3 overflow-hidden rounded-[20px] border border-border bg-card-alt">
      <ScrollView
        style={{ maxHeight: props.maxHeight }}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >
        {asks.map((ask) => (
          <AskRound
            key={`${threadRef.environmentId}:${threadRef.threadId}:${ask.id}:${ask.rounds[ask.rounds.length - 1]!.number}`}
            ask={ask}
            threadRef={threadRef}
            onInputFocusChange={props.onInputFocusChange}
          />
        ))}
        <SignalboxAskHistory asks={history} />
      </ScrollView>
    </View>
  );
}
