import type { ModelSelection } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type CompletionProvider = "anthropic" | "openai";

export type CompletionRequest = {
  readonly path: "/v1/messages" | "/v1/responses";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
};

export type CompletionRequestResult =
  | { readonly _tag: "request"; readonly value: CompletionRequest }
  | { readonly _tag: "unsupported-option"; readonly option: string }
  | { readonly _tag: "invalid-options"; readonly reason: string };

const MAX_OUTPUT_TOKENS = 4096;

/** Builds only the text request shape accepted by the pool's provider API. */
export const completionRequestFor = (
  provider: CompletionProvider,
  selection: ModelSelection,
  prompt: string,
): CompletionRequestResult => {
  const options = selection.options ?? [];
  const effortOptions = options.filter(
    (option) => option.id === "effort" || option.id === "reasoningEffort",
  );
  if (effortOptions.length > 1) {
    return {
      _tag: "invalid-options",
      reason: "Choose either effort or reasoningEffort, not both.",
    };
  }
  const serviceTierOptions = options.filter((option) => option.id === "serviceTier");
  if (serviceTierOptions.length > 1) {
    return { _tag: "invalid-options", reason: "Choose serviceTier only once." };
  }
  const fastModeOptions = options.filter((option) => option.id === "fastMode");
  if (fastModeOptions.length > 1) {
    return { _tag: "invalid-options", reason: "Choose fastMode only once." };
  }
  const unsupported = options.find(
    (option) =>
      option.id !== "effort" &&
      option.id !== "reasoningEffort" &&
      option.id !== "serviceTier" &&
      option.id !== "fastMode",
  );
  if (unsupported !== undefined) {
    return { _tag: "unsupported-option", option: unsupported.id };
  }
  const effort = effortOptions[0]?.value;
  if (effort !== undefined && typeof effort !== "string") {
    return { _tag: "unsupported-option", option: effortOptions[0]!.id };
  }
  const serviceTier = serviceTierOptions[0]?.value;
  if (serviceTier !== undefined && typeof serviceTier !== "string") {
    return { _tag: "unsupported-option", option: "serviceTier" };
  }
  const fastMode = fastModeOptions[0]?.value;
  if (fastMode !== undefined && typeof fastMode !== "boolean") {
    return { _tag: "unsupported-option", option: "fastMode" };
  }
  if (fastMode === true) return { _tag: "unsupported-option", option: "fastMode" };

  let apiServiceTier: string | undefined;
  if (serviceTier !== undefined) {
    if (provider === "openai") {
      switch (serviceTier) {
        case "auto":
        case "default":
        case "flex":
        case "priority":
          apiServiceTier = serviceTier;
          break;
        case "fast":
          apiServiceTier = "priority";
          break;
        default:
          return { _tag: "unsupported-option", option: "serviceTier" };
      }
    } else {
      switch (serviceTier) {
        case "default":
          apiServiceTier = "standard_only";
          break;
        case "auto":
        case "standard_only":
          apiServiceTier = serviceTier;
          break;
        default:
          return { _tag: "unsupported-option", option: "serviceTier" };
      }
    }
  }

  return provider === "anthropic"
    ? {
        _tag: "request",
        value: {
          path: "/v1/messages",
          headers: { "anthropic-version": "2023-06-01" },
          body: {
            model: selection.model,
            max_tokens: MAX_OUTPUT_TOKENS,
            ...(effort === undefined ? {} : { output_config: { effort } }),
            ...(apiServiceTier === undefined ? {} : { service_tier: apiServiceTier }),
            messages: [{ role: "user", content: prompt }],
          },
        },
      }
    : {
        _tag: "request",
        value: {
          path: "/v1/responses",
          headers: {},
          body: {
            model: selection.model,
            stream: false,
            store: false,
            ...(effort === undefined ? {} : { reasoning: { effort } }),
            ...(apiServiceTier === undefined ? {} : { service_tier: apiServiceTier }),
            input: prompt,
          },
        },
      };
};

export interface CompletionUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export type CompletionDecode =
  | { readonly _tag: "text"; readonly text: string; readonly usage?: CompletionUsage }
  | { readonly _tag: "invalid" }
  | { readonly _tag: "failed" }
  | { readonly _tag: "truncated" }
  | { readonly _tag: "refused" }
  | { readonly _tag: "tool-call" }
  | { readonly _tag: "no-text" };

const AnthropicCompletionResponse = Schema.Struct({
  type: Schema.Literal("message"),
  stop_reason: Schema.NullOr(Schema.String),
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  ),
  usage: Schema.optional(
    Schema.Struct({
      input_tokens: Schema.optional(Schema.Number),
      output_tokens: Schema.optional(Schema.Number),
    }),
  ),
});

const OpenAiCompletionResponse = Schema.Struct({
  status: Schema.String,
  output: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      status: Schema.optional(Schema.String),
      content: Schema.optional(
        Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
      ),
    }),
  ),
  incomplete_details: Schema.optional(Schema.NullOr(Schema.Struct({ reason: Schema.String }))),
  usage: Schema.optional(
    Schema.Struct({
      input_tokens: Schema.optional(Schema.Number),
      output_tokens: Schema.optional(Schema.Number),
    }),
  ),
});

const decodeAnthropicResponse = Schema.decodeUnknownOption(AnthropicCompletionResponse);
const decodeOpenAiResponse = Schema.decodeUnknownOption(OpenAiCompletionResponse);

const usageOf = (
  usage:
    | {
        readonly input_tokens?: number | undefined;
        readonly output_tokens?: number | undefined;
      }
    | undefined,
): CompletionUsage | undefined => {
  if (usage === undefined) return undefined;
  return {
    ...(usage.input_tokens === undefined ? {} : { inputTokens: usage.input_tokens }),
    ...(usage.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens }),
  };
};

const textResult = (text: string, usage: CompletionUsage | undefined): CompletionDecode =>
  text.trim().length === 0
    ? { _tag: "no-text" }
    : { _tag: "text", text, ...(usage === undefined ? {} : { usage }) };

/** Validates provider terminal state and extracts only returned text and usage. */
export const decodeCompletionReply = (
  provider: CompletionProvider,
  input: unknown,
): CompletionDecode => {
  if (provider === "anthropic") {
    const decoded = decodeAnthropicResponse(input);
    if (Option.isNone(decoded)) return { _tag: "invalid" };
    const response = decoded.value;
    if (response.stop_reason === "max_tokens") return { _tag: "truncated" };
    if (
      response.stop_reason === "refusal" ||
      response.content.some((part) => part.type === "refusal")
    ) {
      return { _tag: "refused" };
    }
    if (
      response.stop_reason === "tool_use" ||
      response.content.some((part) => part.type === "tool_use")
    ) {
      return { _tag: "tool-call" };
    }
    if (response.stop_reason !== "end_turn" && response.stop_reason !== "stop_sequence") {
      return { _tag: "failed" };
    }
    const text = response.content
      .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
      .join("");
    return textResult(text, usageOf(response.usage));
  }

  const decoded = decodeOpenAiResponse(input);
  if (Option.isNone(decoded)) return { _tag: "invalid" };
  const response = decoded.value;
  if (response.status === "failed" || response.status === "cancelled") {
    return { _tag: "failed" };
  }
  if (response.status === "incomplete") {
    return response.incomplete_details?.reason === "max_output_tokens"
      ? { _tag: "truncated" }
      : { _tag: "failed" };
  }
  if (response.incomplete_details != null) return { _tag: "failed" };
  if (response.status !== "completed") return { _tag: "failed" };
  if (response.output.some((item) => item.type !== "message" && item.type !== "reasoning")) {
    return { _tag: "tool-call" };
  }
  if (response.output.some((item) => item.type === "message" && item.status === "incomplete")) {
    return { _tag: "truncated" };
  }
  if (
    response.output.some(
      (item) => item.type === "message" && item.status !== undefined && item.status !== "completed",
    )
  ) {
    return { _tag: "failed" };
  }
  if (
    response.output.some(
      (item) => item.type === "message" && item.content?.some((part) => part.type === "refusal"),
    )
  ) {
    return { _tag: "refused" };
  }
  const text = response.output
    .flatMap((item) => (item.type === "message" ? (item.content ?? []) : []))
    .flatMap((part) => (part.type === "output_text" && part.text !== undefined ? [part.text] : []))
    .join("");
  return textResult(text, usageOf(response.usage));
};
