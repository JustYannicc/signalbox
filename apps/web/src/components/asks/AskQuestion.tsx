import {
  askKitRecommendation,
  sameAskKitValue,
  updateAskDraft,
  type AskDraftAnswer,
} from "@t3tools/client-runtime/state/signalboxAsks";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { AskKitProblem } from "@t3tools/contracts/askKit";
import type { SignalboxAskQuestion } from "@t3tools/contracts/signalboxAsks";
import { resolveAskKit } from "@t3tools/shared/askKit";
import { useId } from "react";

import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { AskChoices } from "./AskChoices";
import { AskHtmlFrame } from "./AskHtmlFrame";
import { AskKitControl } from "./AskKitControl";

export function askValueText(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function RecommendationButton(props: {
  readonly pressed: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={props.pressed ? "secondary" : "outline"}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      Use recommendation
    </Button>
  );
}

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
  readonly threadRef: ScopedThreadRef;
  readonly onChange: (draft: AskDraftAnswer) => void;
}) {
  const { question, draft, disabled, onChange } = props;
  const id = useId();
  const resolution = resolveAskKit(question);
  const recommendation = askKitRecommendation(question);
  const { spec } = resolution;
  const legacy = spec.component === "legacy";
  const onHtmlAnswer = (value: unknown) =>
    onChange(
      updateAskDraft(draft, {
        selectedOptionIndexes: [],
        useRecommendation: undefined,
        html: { value },
      }),
    );
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
            <dd className="inline">{askValueText(question.recommendation)}</dd>
          </div>
        )}
      </dl>
      {question.surface.kind === "html" ? (
        <div className="flex flex-col gap-1">
          <AskHtmlFrame
            html={question.surface.html}
            title={`Custom view: ${question.question}`}
            maxHeight={480}
            {...(disabled ? {} : { onAnswer: onHtmlAnswer })}
          />
          {draft.html ? (
            <p className="text-xs text-muted-foreground">
              From the view: {askValueText(draft.html.value)}
            </p>
          ) : null}
        </div>
      ) : null}
      {spec.component === "invalid" ? (
        <p className="text-xs text-destructive">
          This question's controls couldn't be shown
          {resolution.problems[0] ? `: ${resolution.problems[0].message}` : "."} Answer in your own
          words below.
        </p>
      ) : null}
      {legacy ? (
        <div className="flex flex-wrap gap-1.5">
          <AskChoices
            label={`Options: ${question.question}`}
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
            <RecommendationButton
              pressed={draft.useRecommendation === true}
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
        </div>
      ) : spec.component !== "invalid" ? (
        <div className="flex flex-col gap-2">
          <AskKitControl
            question={question}
            spec={spec}
            value={draft.kit}
            disabled={disabled}
            threadRef={props.threadRef}
            inputId={id}
            onChange={(kit) => onChange(updateAskDraft(draft, { kit }))}
          />
          {recommendation === null ? null : (
            <div>
              <RecommendationButton
                pressed={sameAskKitValue(draft.kit, recommendation)}
                disabled={disabled}
                onPress={() =>
                  onChange(
                    updateAskDraft(draft, {
                      kit: sameAskKitValue(draft.kit, recommendation) ? undefined : recommendation,
                    }),
                  )
                }
              />
            </div>
          )}
        </div>
      ) : null}
      {spec.component === "text" ? null : (
        <Textarea
          id={id}
          size="sm"
          aria-label={`Answer or comment: ${question.question}`}
          placeholder={
            legacy
              ? "Write an answer or add a comment"
              : "Add a comment, or answer in your own words"
          }
          value={draft.text}
          disabled={disabled}
          onChange={(event) => onChange(updateAskDraft(draft, { text: event.currentTarget.value }))}
        />
      )}
      {props.problem ? (
        <p role="alert" className="text-xs text-destructive">
          {props.problem.message}
        </p>
      ) : null}
    </div>
  );
}
