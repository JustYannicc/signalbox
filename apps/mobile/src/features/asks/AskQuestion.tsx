import {
  askKitRecommendation,
  sameAskKitValue,
  updateAskDraft,
  type AskDraftAnswer,
} from "@t3tools/client-runtime/state/signalboxAsks";
import type { EnvironmentId } from "@t3tools/contracts";
import type { AskKitProblem } from "@t3tools/contracts/askKit";
import type { SignalboxAskQuestion } from "@t3tools/contracts/signalboxAsks";
import { resolveAskKit } from "@t3tools/shared/askKit";
import { View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { RequestActionButton } from "../threads/RequestActionButton";
import { AskChoices } from "./AskChoices";
import { AskHtmlWebView } from "./AskHtmlWebView";
import { AskKitControl } from "./AskKitControl";

export const askValueText = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);

/**
 * One question of a round. Kit components render their own control; surfaces the kit doesn't
 * own keep the options-and-text form, plus the sandboxed view when they carry custom HTML. A
 * kit surface raised wrong says so and takes words only, rather than showing a broken control.
 */
export function AskQuestion(props: {
  readonly question: SignalboxAskQuestion;
  readonly draft: AskDraftAnswer;
  readonly problem: AskKitProblem | undefined;
  readonly disabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly onInputFocusChange: (focused: boolean) => void;
  readonly onChange: (draft: AskDraftAnswer) => void;
}) {
  const { question, draft, disabled, onChange } = props;
  const resolution = resolveAskKit(question);
  const recommendation = askKitRecommendation(question);
  const { spec } = resolution;
  const legacy = spec.component === "legacy";
  return (
    <View className="gap-2">
      <Text className="font-t3-bold text-sm text-foreground">{question.question}</Text>
      <Text className="font-sans text-sm text-foreground-muted">Why: {question.why}</Text>
      <Text className="font-sans text-sm text-foreground-muted">Unblocks: {question.unblocks}</Text>
      <Text className="font-sans text-sm text-foreground-muted">
        Whose decision: {question.decisionOwner}
      </Text>
      {question.recommendation === null ? null : (
        <Text className="font-sans text-sm text-foreground-muted">
          Recommendation: {askValueText(question.recommendation)}
        </Text>
      )}
      {question.surface.kind === "html" ? (
        <View className="gap-1">
          <AskHtmlWebView
            html={question.surface.html}
            title={`Custom view: ${question.question}`}
            maxHeight={480}
            {...(disabled
              ? {}
              : {
                  onAnswer: (value: unknown) =>
                    onChange(
                      updateAskDraft(draft, {
                        selectedOptionIndexes: [],
                        useRecommendation: undefined,
                        html: { value },
                      }),
                    ),
                })}
          />
          {draft.html ? (
            <View className="flex-row items-center gap-2">
              <Text className="flex-1 font-sans text-xs text-foreground-muted">
                From the view: {askValueText(draft.html.value)}
              </Text>
              {/* Unsets only the view's answer; the comment below stays. */}
              <RequestActionButton
                label="Clear"
                tone="secondary"
                accessibilityLabel={`Clear the view's answer: ${question.question}`}
                disabled={disabled}
                onPress={() => onChange(updateAskDraft(draft, { html: undefined }))}
              />
            </View>
          ) : null}
        </View>
      ) : null}
      {spec.component === "invalid" ? (
        <Text className="font-sans text-sm text-danger-foreground">
          This question's controls couldn't be shown
          {resolution.problems[0] ? `: ${resolution.problems[0].message}` : "."} Answer in your own
          words below.
        </Text>
      ) : null}
      {legacy ? (
        <>
          <AskChoices
            options={question.options}
            selected={draft.selectedOptionIndexes}
            multiSelect={question.multiSelect === true}
            disabled={disabled}
            onChange={(selected) =>
              onChange(
                updateAskDraft(draft, {
                  useRecommendation: undefined,
                  selectedOptionIndexes: selected,
                  // Picking an option replaces what the custom view sent.
                  ...(selected.length > 0 ? { html: undefined } : {}),
                }),
              )
            }
          />
          {question.recommendation === null ? null : (
            <RequestActionButton
              label="Use recommendation"
              tone={draft.useRecommendation ? "primary" : "secondary"}
              accessibilityState={{ selected: draft.useRecommendation === true }}
              disabled={disabled}
              onPress={() =>
                onChange(
                  updateAskDraft(draft, {
                    selectedOptionIndexes: [],
                    useRecommendation: draft.useRecommendation ? undefined : true,
                    html: undefined,
                  }),
                )
              }
            />
          )}
        </>
      ) : spec.component !== "invalid" ? (
        <>
          <AskKitControl
            question={question}
            spec={spec}
            value={draft.kit}
            disabled={disabled}
            environmentId={props.environmentId}
            onInputFocusChange={props.onInputFocusChange}
            onChange={(kit) => onChange(updateAskDraft(draft, { kit }))}
          />
          {recommendation === null ? null : (
            <RequestActionButton
              label="Use recommendation"
              tone={sameAskKitValue(draft.kit, recommendation) ? "primary" : "secondary"}
              accessibilityState={{ selected: sameAskKitValue(draft.kit, recommendation) }}
              disabled={disabled}
              onPress={() =>
                onChange(
                  updateAskDraft(draft, {
                    kit: sameAskKitValue(draft.kit, recommendation) ? undefined : recommendation,
                  }),
                )
              }
            />
          )}
        </>
      ) : null}
      {spec.component === "text" ? null : (
        <TextInput
          accessibilityLabel={`Answer or comment: ${question.question}`}
          placeholder={
            legacy
              ? "Write an answer or add a comment"
              : "Add a comment, or answer in your own words"
          }
          multiline
          value={draft.text}
          editable={!disabled}
          onChangeText={(text) => onChange(updateAskDraft(draft, { text }))}
          onFocus={() => props.onInputFocusChange(true)}
          onBlur={() => props.onInputFocusChange(false)}
        />
      )}
      {props.problem ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {props.problem.message}
        </Text>
      ) : null}
    </View>
  );
}
