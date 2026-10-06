import {
  automationAskFieldInitial,
  parseAutomationAsk,
  resolveAutomationAskAnswer,
  type AutomationAsk,
  type AutomationAskAnswerInput,
  type AutomationAskField,
  type AutomationStep,
  type AutomationWaitingQuestion,
} from "@t3tools/contracts";

/**
 * Answering a `w.ask`: the question behind a waiting step, the form a person
 * fills in, and the answer the server will accept. Every client answers
 * through these so a form reads and checks the same everywhere.
 */

/**
 * What the form holds while someone fills it in: text and numbers as the text
 * typed, booleans as booleans, a choice field as its option or null.
 */
export type AskDraftValue = string | boolean | null;
export type AskDraft = Readonly<Record<string, AskDraftValue>>;

export function askFromQuestion(question: AutomationWaitingQuestion): AutomationAsk {
  return {
    question: question.question,
    options: question.options,
    multi: question.multi,
    fields: question.fields,
    onTimeout: null,
  };
}

/**
 * The question behind a waiting `ask` step, for when the automation's waiting
 * list hasn't caught up with the run yet. Null for anything not waiting on you.
 */
export function questionFromStep(
  runId: string,
  step: Pick<AutomationStep, "key" | "verb" | "status" | "label" | "args" | "startedAt">,
): AutomationWaitingQuestion | null {
  if (step.verb !== "ask" || step.status !== "waiting") return null;
  const { ask } = parseAutomationAsk(Array.isArray(step.args) ? step.args[0] : undefined);
  return {
    runId,
    stepKey: step.key,
    label: step.label,
    question: ask.question,
    options: ask.options,
    multi: ask.multi,
    fields: ask.fields,
    since: step.startedAt,
  };
}

/**
 * Every question waiting in a run, by step key: the automation's waiting list,
 * plus any waiting `ask` step that list doesn't have yet.
 */
export function runQuestions(
  runId: string,
  steps: ReadonlyArray<AutomationStep>,
  waiting: ReadonlyArray<AutomationWaitingQuestion>,
): ReadonlyMap<string, AutomationWaitingQuestion> {
  const questions = new Map<string, AutomationWaitingQuestion>();
  for (const question of waiting) {
    if (question.runId === runId) questions.set(question.stepKey, question);
  }
  for (const step of steps) {
    if (questions.has(step.key)) continue;
    const question = questionFromStep(runId, step);
    if (question) questions.set(step.key, question);
  }
  return questions;
}

export function initialAskDraft(fields: ReadonlyArray<AutomationAskField>): AskDraft {
  const draft: Record<string, AskDraftValue> = {};
  for (const field of fields) {
    const initial = automationAskFieldInitial(field);
    switch (field.type) {
      case "boolean":
        draft[field.name] = initial === true;
        break;
      case "choice":
        draft[field.name] = typeof initial === "string" ? initial : null;
        break;
      default:
        draft[field.name] = initial === null ? "" : String(initial);
    }
  }
  return draft;
}

/**
 * The form's values as the server reads them. An empty number is null; text
 * that isn't a number stays text so the ask's check names the field.
 */
export function askDraftValues(
  fields: ReadonlyArray<AutomationAskField>,
  draft: AskDraft,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const value = draft[field.name] ?? null;
    if (field.type === "boolean") {
      values[field.name] = value === true;
    } else if (field.type === "number" && typeof value === "string") {
      const text = value.trim();
      const parsed = text === "" ? null : Number(text);
      values[field.name] = parsed === null ? null : Number.isFinite(parsed) ? parsed : text;
    } else {
      values[field.name] = value;
    }
  }
  return values;
}

/**
 * Checks an answer the way the server will and builds its payload: `choice`
 * for one option, `choices` for a multi ask, `values` when there's a form.
 */
export function buildAskAnswer(
  ask: AutomationAsk,
  picked: { readonly choice: string } | { readonly choices: ReadonlyArray<string> },
  draft: AskDraft,
):
  | { readonly ok: true; readonly input: AutomationAskAnswerInput }
  | { readonly ok: false; readonly error: string } {
  const values = ask.fields.length > 0 ? askDraftValues(ask.fields, draft) : undefined;
  const input: AutomationAskAnswerInput = {
    ...("choice" in picked ? { choice: picked.choice } : { choices: picked.choices }),
    ...(values ? { values } : {}),
  };
  const checked = resolveAutomationAskAnswer(ask, input);
  return checked.ok ? { ok: true, input } : { ok: false, error: checked.error };
}
