import type {
  OrchestrationV2UserInputQuestion,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const Choice = Schema.Struct({
  const: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});
const Choices = {
  enum: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  enumNames: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  oneOf: Schema.optional(Schema.NullOr(Schema.Array(Choice))),
  anyOf: Schema.optional(Schema.NullOr(Schema.Array(Choice))),
};
const Field = Schema.Struct({
  type: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  format: Schema.optional(Schema.NullOr(Schema.String)),
  writeOnly: Schema.optional(Schema.Boolean),
  isSecret: Schema.optional(Schema.Boolean),
  default: Schema.optional(Schema.Unknown),
  items: Schema.optional(Schema.Struct(Choices)),
  minItems: Schema.optional(Schema.Number),
  maxItems: Schema.optional(Schema.Number),
  ...Choices,
});
const Form = Schema.Struct({
  type: Schema.optional(Schema.Literal("object")),
  properties: Schema.optional(Schema.Record(Schema.String, Field)),
  required: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});
const isForm = Schema.is(Form);

function fieldOptions(field: typeof Field.Type | NonNullable<typeof Field.Type.items>) {
  const titled = field.oneOf ?? field.anyOf;
  return titled != null
    ? titled.map((choice) => ({
        value: choice.const,
        label: choice.title?.trim() || choice.const,
        description: choice.description?.trim() || choice.title?.trim() || choice.const,
      }))
    : (field.enum ?? []).map((value, index) => ({
        value,
        label: field.enumNames?.[index]?.trim() || value,
        description: field.enumNames?.[index]?.trim() || value,
      }));
}

export function nativeElicitationForm(schema: unknown, message: string) {
  if (!isForm(schema)) return null;
  if (schema.required?.some((id) => !Object.hasOwn(schema.properties ?? {}, id))) return null;
  const questions: OrchestrationV2UserInputQuestion[] = [];
  for (const [id, field] of Object.entries(schema.properties ?? {})) {
    if (!id.trim() || field.isSecret || field.writeOnly || field.format === "password") return null;
    const type = field.type ?? "string";
    if (!["string", "boolean", "number", "integer", "array"].includes(type)) return null;
    const options = fieldOptions(type === "array" ? (field.items ?? {}) : field);
    if (type === "array" && options.length === 0) return null;
    if (options.some((option) => !option.label.trim() || !option.description.trim())) return null;
    const initial = field.default;
    questions.push({
      id,
      header: field.title?.trim() || `Question ${questions.length + 1}`,
      question: field.description?.trim() || message.trim() || field.title?.trim() || id,
      options:
        type === "boolean"
          ? [
              { label: "true", value: "true", description: "Yes" },
              { label: "false", value: "false", description: "No" },
            ]
          : options,
      multiSelect: type === "array",
      allowCustomAnswer: options.length === 0 && type !== "boolean",
      required: schema.required?.includes(id) ?? false,
      ...(typeof initial === "string" || typeof initial === "number" || typeof initial === "boolean"
        ? { initialAnswer: String(initial) }
        : {}),
    });
  }
  return { questions, schema };
}

function fieldAnswer(field: typeof Field.Type, answer: unknown) {
  if (field.type !== "array" && Array.isArray(answer) && answer.length === 1) answer = answer[0];
  switch (field.type ?? "string") {
    case "boolean":
      return answer === true || answer === "true"
        ? true
        : answer === false || answer === "false"
          ? false
          : undefined;
    case "number":
    case "integer": {
      const number =
        typeof answer === "number"
          ? answer
          : typeof answer === "string" && answer.trim()
            ? Number(answer)
            : NaN;
      return Number.isFinite(number) && (field.type !== "integer" || Number.isInteger(number))
        ? number
        : undefined;
    }
    case "array": {
      const values = typeof answer === "string" ? [answer] : answer;
      const options = fieldOptions(field.items ?? {});
      return Array.isArray(values) &&
        values.every(
          (value: unknown) =>
            typeof value === "string" && options.some((option) => option.value === value),
        ) &&
        new Set(values).size === values.length &&
        values.length >= (field.minItems ?? 0) &&
        values.length <= (field.maxItems ?? Infinity)
        ? values.filter((value): value is string => typeof value === "string")
        : undefined;
    }
    default: {
      const options = fieldOptions(field);
      return typeof answer === "string" &&
        (options.length === 0 || options.some((option) => option.value === answer))
        ? answer
        : undefined;
    }
  }
}

export function nativeElicitationResponse(
  form: ReturnType<typeof nativeElicitationForm>,
  answers: ProviderUserInputAnswers,
):
  | { action: "accept"; content: Record<string, string | number | boolean | string[]> }
  | { action: "decline"; _meta?: { "signalbox/reason": string } } {
  if (form === null)
    return {
      action: "decline",
      _meta: {
        "signalbox/reason":
          "Unsupported form. Secret questions must use request_secret or URL elicitation.",
      },
    };
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const [id, field] of Object.entries(form.schema.properties ?? {})) {
    if (!Object.hasOwn(answers, id)) {
      if (form.schema.required?.includes(id)) return { action: "decline" };
      continue;
    }
    const value = fieldAnswer(field, answers[id]);
    if (value === undefined) return { action: "decline" };
    content[id] = value;
  }
  return { action: "accept", content };
}
