/**
 * A waiting `w.ask`: its question, its form when it has fields, and one
 * button per option (checkboxes and Submit for `multi`). The same control
 * answers from the diagram's details panel, the overview and Home, so a
 * simple approve or reject never needs the diagram. An ask that names a
 * thread (`open`) offers to open it, or its agent's live browser.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  automationOptionLabel,
  type AutomationAskField,
  type AutomationAskOpen,
  type AutomationWaitingQuestion,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  askFromQuestion,
  buildAskAnswer,
  initialAskDraft,
  type AskDraft,
  type AskDraftValue,
} from "@t3tools/client-runtime/automations/ask";
import { useNavigate } from "@tanstack/react-router";
import { useId, useMemo, useState } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { automationState } from "../../state/automations";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { useAutomationCommand } from "./useAutomationCommand";

function AskFieldInput(props: {
  field: AutomationAskField;
  value: AskDraftValue;
  onChange: (value: AskDraftValue) => void;
  disabled: boolean;
  rail: boolean;
}) {
  const { field, value } = props;
  const id = useId();
  const text = typeof value === "string" ? value : "";
  if (field.type === "boolean") {
    return (
      <Label>
        <Switch
          size="sm"
          checked={value === true}
          disabled={props.disabled}
          onCheckedChange={(checked) => props.onChange(checked)}
        />
        {field.label}
      </Label>
    );
  }
  const control = (() => {
    switch (field.type) {
      case "longText":
        return (
          <Textarea
            id={id}
            size={props.rail ? "sm" : "default"}
            value={text}
            required={field.required}
            disabled={props.disabled}
            onChange={(event) => props.onChange(event.currentTarget.value)}
          />
        );
      case "choice":
        return (
          <Select
            value={typeof value === "string" ? value : null}
            disabled={props.disabled}
            onValueChange={(next) => {
              if (next !== null) props.onChange(next);
            }}
          >
            <SelectTrigger id={id} size="sm">
              <SelectValue>
                {typeof value === "string" ? automationOptionLabel(value) : "Choose…"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {field.options.map((option) => (
                <SelectItem key={option} value={option}>
                  {automationOptionLabel(option)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        );
      default:
        return (
          <Input
            id={id}
            size={props.rail ? "sm" : "default"}
            {...(field.type === "number" ? { type: "number", inputMode: "decimal" as const } : {})}
            value={text}
            required={field.required}
            disabled={props.disabled}
            onChange={(event) => props.onChange(event.currentTarget.value)}
          />
        );
    }
  })();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id}>
        {field.label}
        {field.required ? <span className="text-muted-foreground">(required)</span> : null}
      </Label>
      {control}
    </div>
  );
}

export function AskAnswer(props: {
  environmentId: EnvironmentId;
  question: AutomationWaitingQuestion;
  /** The rail is narrow: smaller buttons, the question clamped. */
  density?: "panel" | "rail";
  /** Shows the ask's label above the question; off where a heading already says it. */
  showTitle?: boolean;
  /** Shows the question's text; off where the surrounding view already says it. */
  showQuestion?: boolean;
  /** Offers what the ask opens; off where it's open already. */
  showOpen?: boolean;
}) {
  const { question } = props;
  const ask = useMemo(() => askFromQuestion(question), [question]);
  const answer = useAutomationCommand(automationState.answer, "Couldn't send your answer");
  const pending = answer.busy;
  const [draft, setDraft] = useState<AskDraft>(() => initialAskDraft(question.fields));
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const rail = props.density === "rail";

  const send = async (choice: { readonly choice: string } | { readonly choices: string[] }) => {
    if (pending) return;
    // The server runs the same check; this one just answers without a round trip.
    const built = buildAskAnswer(ask, choice, draft);
    if (!built.ok) {
      setProblem(built.error);
      return;
    }
    setProblem(null);
    await answer.run({
      environmentId: props.environmentId,
      input: { runId: question.runId, stepKey: question.stepKey, ...built.input },
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {props.showTitle === false ? null : (
        <p className="text-sm font-medium text-balance text-foreground">{question.label}</p>
      )}
      {question.question && props.showQuestion !== false ? (
        <p
          className={
            rail
              ? "line-clamp-4 text-xs whitespace-pre-wrap text-muted-foreground"
              : "max-h-60 overflow-y-auto rounded-md bg-muted/50 px-2.5 py-2 text-xs whitespace-pre-wrap text-foreground"
          }
        >
          {question.question}
        </p>
      ) : null}
      {question.fields.length > 0 ? (
        <div className="flex flex-col gap-2.5">
          {question.fields.map((field) => (
            <AskFieldInput
              key={field.name}
              field={field}
              value={draft[field.name] ?? null}
              onChange={(value) => setDraft((current) => ({ ...current, [field.name]: value }))}
              disabled={pending}
              rail={rail}
            />
          ))}
        </div>
      ) : null}
      {question.multi ? (
        <div className="flex flex-col gap-1.5">
          {question.options.map((option) => (
            <Label key={option}>
              <Checkbox
                checked={picked.has(option)}
                disabled={pending}
                onCheckedChange={(checked) =>
                  setPicked((current) => {
                    const next = new Set(current);
                    if (checked) next.add(option);
                    else next.delete(option);
                    return next;
                  })
                }
              />
              {automationOptionLabel(option)}
            </Label>
          ))}
        </div>
      ) : null}
      {problem ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {question.multi ? (
          <Button
            size={rail ? "xs" : "sm"}
            disabled={pending}
            onClick={() =>
              void send({ choices: question.options.filter((option) => picked.has(option)) })
            }
          >
            Submit
          </Button>
        ) : (
          question.options.map((option, index) => (
            <Button
              key={option}
              size={rail ? "xs" : "sm"}
              variant={index === 0 ? "default" : "outline"}
              disabled={pending}
              onClick={() => void send({ choice: option })}
            >
              {automationOptionLabel(option)}
            </Button>
          ))
        )}
        {question.open && props.showOpen !== false ? (
          <AskOpenButton
            environmentId={props.environmentId}
            open={question.open}
            size={rail ? "xs" : "sm"}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Opens the thread an ask names, with its agent's browser beside it for `view: "browser"`. */
function AskOpenButton(props: {
  environmentId: EnvironmentId;
  open: AutomationAskOpen;
  size: "xs" | "sm";
}) {
  const navigate = useNavigate();
  const { environmentId, open } = props;
  return (
    <Button
      size={props.size}
      variant="ghost"
      onClick={() => {
        const ref = scopeThreadRef(environmentId, open.threadId);
        if (open.view === "browser") useRightPanelStore.getState().open(ref, "agent-browser");
        void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
      }}
    >
      {open.view === "browser" ? "Open the browser" : "Open thread"}
    </Button>
  );
}
