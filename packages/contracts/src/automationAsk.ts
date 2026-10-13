import * as Schema from "effect/Schema";

/**
 * What a `w.ask` step asks for and what counts as an answer. The compiler
 * checks literal specs with `askFieldProblems`, the engine parses the
 * journaled args with `parseAutomationAsk` and checks answers with
 * `resolveAutomationAskAnswer`, and clients render the same parsed ask, so
 * the three can't drift apart.
 */

export const AutomationAskFieldType = Schema.Literals([
  "text",
  "longText",
  "number",
  "boolean",
  "choice",
]);
export type AutomationAskFieldType = typeof AutomationAskFieldType.Type;

export const AutomationAskValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);
export type AutomationAskValue = typeof AutomationAskValue.Type;

/** One input of an ask's form, as the code declared it under `fields`, in code order. */
export const AutomationAskField = Schema.Struct({
  name: Schema.String,
  type: AutomationAskFieldType,
  /** The code's `label`, else the name in words ("dueDate" → "Due date"). */
  label: Schema.String,
  default: Schema.NullOr(AutomationAskValue),
  /** The choices of a `choice` field; empty for the other types. */
  options: Schema.Array(Schema.String),
  required: Schema.Boolean,
});
export type AutomationAskField = typeof AutomationAskField.Type;

/** What `w.ask` offers when the code names no options and no fields. */
export const AUTOMATION_ASK_DEFAULT_OPTIONS: ReadonlyArray<string> = ["approve", "reject"];
/** The one action of an ask with fields and no options. */
export const AUTOMATION_ASK_SUBMIT = "submit";

export interface AutomationAsk {
  /** The `question` option as text; JSON when the code passed data. */
  readonly question: string | null;
  readonly options: ReadonlyArray<string>;
  /** `multi: true`: any number of options, answered as an array. */
  readonly multi: boolean;
  readonly fields: ReadonlyArray<AutomationAskField>;
  /** `onTimeout`: an option, `"fail"`, or null when the code gave none. */
  readonly onTimeout: string | null;
}

/** What a person sent: the option they picked (or several for `multi`) and the form's values. */
export interface AutomationAskAnswerInput {
  readonly choice?: string;
  readonly choices?: ReadonlyArray<string>;
  readonly values?: { readonly [name: string]: unknown };
}

const FIELD_TYPES = new Set<string>(AutomationAskFieldType.literals);
const FIELD_KEYS = new Set(["type", "label", "default", "options", "required"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** "dueDate" / "due_date" → "Due date". */
function automationAskFieldLabel(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/** "needs_review" → "Needs review": options are identifiers in code, buttons read as words. */
export function automationOptionLabel(option: string): string {
  const words = option.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : option;
}

function valueFits(field: { type: string; options: ReadonlyArray<string> }, value: unknown) {
  switch (field.type) {
    case "text":
    case "longText":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "choice":
      return typeof value === "string" && field.options.includes(value);
    default:
      return false;
  }
}

const TYPE_WORDS: Record<AutomationAskFieldType, string> = {
  text: "text",
  longText: "text",
  number: "a number",
  boolean: "true or false",
  choice: "one of its options",
};

/**
 * What's wrong with one entry of `fields`. `unknownKeys` names properties the
 * compiler can't read because they're computed; their checks are skipped.
 */
export function askFieldProblems(
  name: string,
  spec: unknown,
  unknownKeys: ReadonlySet<string> = new Set(),
): string[] {
  const entry = record(spec);
  if (!entry) return [`Field "${name}" must be an object like { type: "text" }.`];
  const problems: string[] = [];
  for (const key of Object.keys(entry)) {
    if (!FIELD_KEYS.has(key)) problems.push(`Field "${name}" has an unknown option "${key}".`);
  }
  if (unknownKeys.has("type")) return problems;
  const type = entry.type;
  if (typeof type !== "string" || !FIELD_TYPES.has(type)) {
    problems.push(`Field "${name}" needs a type: ${[...FIELD_TYPES].join(", ")}.`);
    return problems;
  }
  if (!unknownKeys.has("label") && entry.label !== undefined && typeof entry.label !== "string") {
    problems.push(`Field "${name}"'s label must be text.`);
  }
  if (
    !unknownKeys.has("required") &&
    entry.required !== undefined &&
    typeof entry.required !== "boolean"
  ) {
    problems.push(`Field "${name}"'s required must be true or false.`);
  }
  const optionsKnown = !unknownKeys.has("options");
  const options = Array.isArray(entry.options) ? entry.options : null;
  if (type === "choice" && optionsKnown) {
    if (!options || options.length === 0 || !options.every((o) => typeof o === "string")) {
      problems.push(`Choice field "${name}" needs options, a list of strings.`);
    }
  } else if (type !== "choice" && entry.options !== undefined && optionsKnown) {
    problems.push(`Only choice fields take options; "${name}" is ${type}.`);
  }
  if (
    !unknownKeys.has("default") &&
    entry.default !== undefined &&
    entry.default !== null &&
    (optionsKnown || type !== "choice") &&
    !valueFits({ type, options: (options ?? []).map(String) }, entry.default)
  ) {
    problems.push(
      `Field "${name}"'s default must be ${TYPE_WORDS[type as AutomationAskFieldType]}.`,
    );
  }
  return problems;
}

function readOptions(value: unknown, problems: string[]): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    problems.push("options must be a list of strings.");
    return [];
  }
  const options: string[] = [];
  for (const option of value) {
    if (typeof option !== "string" && typeof option !== "number") {
      problems.push(`options must be strings; one is ${JSON.stringify(option) ?? "undefined"}.`);
      continue;
    }
    const text = String(option);
    if (text.trim() && !options.includes(text)) options.push(text);
  }
  if (options.length === 0) problems.push("options is empty, so there's nothing to answer with.");
  return options;
}

/**
 * The ask behind a step's options object (`args[0]`). `problems` lists what
 * makes it unanswerable; the engine fails the step on any.
 */
export function parseAutomationAsk(input: unknown): {
  readonly ask: AutomationAsk;
  readonly problems: ReadonlyArray<string>;
} {
  const options = record(input) ?? {};
  const problems: string[] = [];
  const fields: AutomationAskField[] = [];
  const fieldSpecs = options.fields;
  if (fieldSpecs !== undefined && fieldSpecs !== null) {
    const specs = record(fieldSpecs);
    if (!specs) problems.push("fields must be an object of { name: { type } }.");
    for (const [name, spec] of Object.entries(specs ?? {})) {
      const fieldProblems = askFieldProblems(name, spec);
      problems.push(...fieldProblems);
      if (fieldProblems.length > 0) continue;
      const entry = spec as Record<string, unknown>;
      fields.push({
        name,
        type: entry.type as AutomationAskFieldType,
        label:
          typeof entry.label === "string" && entry.label.trim()
            ? entry.label
            : automationAskFieldLabel(name),
        default: (entry.default ?? null) as AutomationAskValue | null,
        options: Array.isArray(entry.options) ? entry.options.map(String) : [],
        required: entry.required === true,
      });
    }
  }
  const multi = options.multi === true;
  const listed = readOptions(options.options, problems);
  const question =
    options.question === undefined || options.question === null
      ? null
      : typeof options.question === "string"
        ? options.question
        : (JSON.stringify(options.question, null, 2) ?? null);
  return {
    ask: {
      question: question?.trim() ? question : null,
      options:
        listed ??
        (fieldSpecs !== undefined && fieldSpecs !== null
          ? [AUTOMATION_ASK_SUBMIT]
          : AUTOMATION_ASK_DEFAULT_OPTIONS),
      multi,
      fields,
      onTimeout: typeof options.onTimeout === "string" ? options.onTimeout : null,
    },
    problems,
  };
}

/** The value a field starts with in a form, and stands for when nobody filled it. */
export function automationAskFieldInitial(field: AutomationAskField): AutomationAskValue | null {
  return field.default ?? (field.type === "boolean" ? false : null);
}

function resolveValues(
  ask: AutomationAsk,
  values: { readonly [name: string]: unknown },
  enforceRequired: boolean,
): { ok: true; values: Record<string, AutomationAskValue | null> } | { ok: false; error: string } {
  const resolved: Record<string, AutomationAskValue | null> = {};
  for (const field of ask.fields) {
    const given = values[field.name];
    const value = given === undefined ? automationAskFieldInitial(field) : given;
    if (value !== null && !valueFits(field, value)) {
      return { ok: false, error: `${field.label} must be ${TYPE_WORDS[field.type]}.` };
    }
    const empty = value === null || (typeof value === "string" && !value.trim());
    if (enforceRequired && field.required && field.type !== "boolean" && empty) {
      return { ok: false, error: `${field.label} is required.` };
    }
    resolved[field.name] = value as AutomationAskValue | null;
  }
  return { ok: true, values: resolved };
}

/**
 * Checks an answer against the ask and builds the step's result: the option,
 * the options for `multi`, and `{ choice, values }` when the ask has fields.
 */
export function resolveAutomationAskAnswer(
  ask: AutomationAsk,
  answer: AutomationAskAnswerInput,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string } {
  const offered = `Answer with ${ask.multi ? "any of" : "one of"}: ${ask.options.join(", ")}.`;
  let choice: string | string[];
  if (ask.multi) {
    const picked = answer.choices ?? (answer.choice === undefined ? null : [answer.choice]);
    if (!picked || !picked.every((option) => ask.options.includes(option))) {
      return { ok: false, error: offered };
    }
    choice = ask.options.filter((option) => picked.includes(option));
  } else {
    if (answer.choice === undefined || !ask.options.includes(answer.choice)) {
      return { ok: false, error: offered };
    }
    choice = answer.choice;
  }
  if (ask.fields.length === 0) return { ok: true, value: choice };
  const values = resolveValues(ask, answer.values ?? {}, true);
  return values.ok ? { ok: true, value: { choice, values: values.values } } : values;
}

/**
 * The step's result when nobody answered in time and `onTimeout` names an
 * option; fields keep their defaults. Null means the step fails.
 */
export function automationAskTimeoutValue(ask: AutomationAsk): { readonly value: unknown } | null {
  const fallback = ask.onTimeout;
  if (fallback === null || fallback === "fail" || !ask.options.includes(fallback)) return null;
  const choice = ask.multi ? [fallback] : fallback;
  if (ask.fields.length === 0) return { value: choice };
  const values = resolveValues(ask, {}, false);
  return values.ok ? { value: { choice, values: values.values } } : null;
}
