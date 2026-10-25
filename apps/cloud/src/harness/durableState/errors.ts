import * as Schema from "effect/Schema";

const messages = {
  INVALID: "Durable state input is invalid.",
  MISSING: "Durable state was not found.",
  CONFLICT: "Durable state conflicts with this operation.",
  STALE_CONTROL: "The controller claim is stale.",
  STALE_PUBLISHER: "The facet publisher is stale.",
  OUT_OF_ORDER: "Durable state does not allow this operation yet.",
  INDETERMINATE: "Durable state needs reconciliation.",
  LIMIT: "Durable state exceeded its configured limit.",
  CORRUPT: "Durable state is corrupt.",
  STORAGE: "Durable state storage failed.",
} as const;

export type HarnessDurableStateErrorCode = keyof typeof messages;
const errorCodes = [
  "INVALID",
  "MISSING",
  "CONFLICT",
  "STALE_CONTROL",
  "STALE_PUBLISHER",
  "OUT_OF_ORDER",
  "INDETERMINATE",
  "LIMIT",
  "CORRUPT",
  "STORAGE",
] as const satisfies readonly HarnessDurableStateErrorCode[];

export class HarnessDurableStateError extends Schema.TaggedError<HarnessDurableStateError>()(
  "HarnessDurableStateError",
  {
    code: Schema.Literals(errorCodes),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return messages[this.code];
  }
}

const isHarnessDurableStateError = Schema.is(HarnessDurableStateError);

export function codeOf(error: unknown): HarnessDurableStateErrorCode {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    Object.hasOwn(messages, error.code)
  )
    return error.code as HarnessDurableStateErrorCode;
  return "STORAGE";
}

export function failureOf(error: unknown) {
  const failure = isHarnessDurableStateError(error)
    ? error
    : new HarnessDurableStateError({ code: codeOf(error), cause: error });
  return { code: failure.code, message: failure.message };
}

export function hasCode(error: unknown, code: HarnessDurableStateErrorCode): boolean {
  return codeOf(error) === code;
}
