import {
  askFromQuestion,
  buildAskAnswer,
  initialAskDraft,
  type AskDraft,
  type AskDraftValue,
} from "@t3tools/client-runtime/automations/ask";
import {
  automationOptionLabel,
  type AutomationWaitingQuestion,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Haptics from "expo-haptics";
import { useMemo, useState } from "react";
import { Alert, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { automationState } from "../../state/automations";
import { useAtomCommand } from "../../state/use-atom-command";
import { AskField } from "./AskFields";
import { PillButton } from "./AutomationParts";

/** Marks the action being sent: an option, or the multi ask's one Send button. */
const SEND_PICKED = "\u0000send";

/**
 * A question an `ask` step is waiting on: its form, if it has fields, then
 * one button per option. The first option is the primary action, matching how
 * authors order them ("send", "skip"). A `multi` ask turns its options into
 * toggles with one Send button. Answers are checked here first so a missing
 * field says so inline; the server runs the same check.
 */
export function AskAnswer(props: {
  readonly environmentId: EnvironmentId;
  readonly question: AutomationWaitingQuestion;
  readonly showQuestion?: boolean;
}) {
  const { question } = props;
  const ask = useMemo(() => askFromQuestion(question), [question]);
  const answer = useAtomCommand(automationState.answer, {
    label: "automation answer",
    reportFailure: false,
  });
  const [draft, setDraft] = useState<AskDraft>(() => initialAskDraft(question.fields));
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const busy = sending !== null;

  const setField = (name: string, value: AskDraftValue) => {
    setError(null);
    setDraft((current) => ({ ...current, [name]: value }));
  };

  const send = async (action: string) => {
    const built = buildAskAnswer(
      ask,
      action === SEND_PICKED
        ? { choices: ask.options.filter((option) => picked.has(option)) }
        : { choice: action },
      draft,
    );
    if (!built.ok) {
      setError(built.error);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }
    setError(null);
    setSending(action);
    void Haptics.selectionAsync();
    const result = await answer({
      environmentId: props.environmentId,
      input: { runId: question.runId, stepKey: question.stepKey, ...built.input },
    });
    setSending(null);
    if (result._tag === "Success") {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else if (!isAtomCommandInterrupted(result)) {
      Alert.alert("Couldn't send your answer", String(squashAtomCommandFailure(result)));
    }
  };

  return (
    <View className="gap-3">
      {props.showQuestion === false ? null : (
        <Text className="text-base leading-normal text-foreground" selectable numberOfLines={12}>
          {question.question ?? question.label}
        </Text>
      )}
      {question.fields.map((field) => (
        <AskField
          key={field.name}
          field={field}
          value={draft[field.name] ?? null}
          disabled={busy}
          onChange={(value) => setField(field.name, value)}
        />
      ))}
      {ask.multi ? (
        <>
          <View className="flex-row flex-wrap gap-2">
            {ask.options.map((option) => (
              <PillButton
                key={option}
                label={automationOptionLabel(option)}
                accessibilityRole="checkbox"
                tone={picked.has(option) ? "primary" : "secondary"}
                selected={picked.has(option)}
                disabled={busy}
                onPress={() => {
                  setError(null);
                  void Haptics.selectionAsync();
                  setPicked((current) => {
                    const next = new Set(current);
                    if (!next.delete(option)) next.add(option);
                    return next;
                  });
                }}
              />
            ))}
          </View>
          <View className="flex-row">
            <PillButton
              label={sending === SEND_PICKED ? "Sending…" : "Send"}
              tone="primary"
              size="md"
              disabled={busy}
              dimmed={false}
              onPress={() => void send(SEND_PICKED)}
            />
          </View>
        </>
      ) : (
        <View className="flex-row flex-wrap gap-2">
          {question.options.map((option, index) => (
            <PillButton
              key={option}
              label={sending === option ? "Sending…" : automationOptionLabel(option)}
              tone={index === 0 ? "primary" : "secondary"}
              size="md"
              disabled={busy}
              dimmed={busy && sending !== option}
              onPress={() => void send(option)}
            />
          ))}
        </View>
      )}
      {error ? (
        <Text accessibilityLiveRegion="polite" className="text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
