import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The portable shape syntax used by w.extract, including nested objects and arrays. */
function shapeOf(shape: unknown): Schema.Codec<unknown> {
  switch (shape) {
    case "string":
      return Schema.String;
    case "number":
      return Schema.Number;
    case "boolean":
      return Schema.Boolean;
    case "null":
      return Schema.Null;
  }
  if (Array.isArray(shape)) {
    if (shape.length !== 1) throw new Error("An array shape needs exactly one item shape.");
    return Schema.Array(shapeOf(shape[0]));
  }
  if (typeof shape === "object" && shape !== null)
    return Schema.Struct(
      Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, shapeOf(value)])),
    );
  throw new Error(`Unsupported extraction shape: ${JSON.stringify(shape)}.`);
}

export type ModelOutput =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

const decodeJudgeVerdict = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ verdict: Schema.Boolean, reason: Schema.String })),
);

/** Compiles the supplied shape before a model request can spend an attempt. */
export function extractionOutput(
  shape: unknown,
):
  | { readonly ok: true; readonly decode: (text: string) => ModelOutput }
  | { readonly ok: false; readonly error: string } {
  try {
    const schema = shape === undefined ? Schema.Unknown : shapeOf(shape);
    const decode = Schema.decodeUnknownOption(Schema.fromJsonString(schema));
    return {
      ok: true,
      decode: (text) => {
        const stripped = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
        const value = decode(stripped);
        return Option.isSome(value) && !(shape === undefined && typeof value.value === "string")
          ? { ok: true, value: value.value }
          : { ok: false, error: "The model's JSON doesn't match the extraction schema." };
      },
    };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : "Invalid extraction schema.",
    };
  }
}

/** Decodes only JSON, then checks the supplied shape before anything reaches the workflow. */
export function jsonModelOutput(text: string, shape: unknown): ModelOutput {
  const output = extractionOutput(shape);
  return output.ok ? output.decode(text) : output;
}

export function judgeVerdict(text: string): ModelOutput {
  const value = decodeJudgeVerdict(text.trim());
  return Option.isSome(value) && value.value.reason.trim().length > 0
    ? { ok: true, value: value.value }
    : { ok: false, error: "The model must answer with a boolean verdict and a reason." };
}
