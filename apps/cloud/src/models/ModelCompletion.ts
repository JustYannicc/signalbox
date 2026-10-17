import type { ModelSelection } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { PoolModelApi } from "../pool/PoolDirectory.ts";
import type { ModelPoolRoute } from "./ModelProtocol.ts";
import {
  completionRequestFor,
  decodeCompletionReply,
  type CompletionProvider,
} from "./internal/completionProtocol.ts";
import { poolKindOfInstance } from "../thread/providerCatalog.ts";

export class ModelCompletionError extends Schema.TaggedError<ModelCompletionError>()(
  "ModelCompletionError",
  {
    code: Schema.Literals([
      "unsupported-provider",
      "unsupported-option",
      "invalid-options",
      "pool-denied",
      "pool-unavailable",
      "http-error",
      "invalid-response",
      "provider-failed",
      "provider-refused",
      "truncated",
      "tool-call",
      "no-text",
    ]),
    reason: Schema.String,
    status: Schema.optional(Schema.Number),
  },
) {
  override get message() {
    return this.reason;
  }
}

export interface ModelCompletionRequest {
  readonly pool: ModelPoolRoute;
  readonly modelSelection: ModelSelection;
  readonly prompt: string;
}

export class ModelCompletion extends Context.Service<
  ModelCompletion,
  {
    readonly complete: (
      request: ModelCompletionRequest,
    ) => Effect.Effect<string, ModelCompletionError>;
  }
>()("@signalbox/cloud/models/ModelCompletion") {}

const providerOf = (instanceId: ModelSelection["instanceId"]): CompletionProvider | undefined => {
  const kind = poolKindOfInstance(instanceId);
  return kind === "claude" ? "anthropic" : kind === "codex" ? "openai" : undefined;
};

const requestBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const fail = (code: ModelCompletionError["code"], reason: string) =>
  Effect.fail(new ModelCompletionError({ code, reason }));

const cancelBody = (response: Response) =>
  Effect.promise(async () => {
    try {
      await response.body?.cancel();
    } catch {
      // The response already failed; body cancellation is only cleanup.
    }
  });

const usageAttributes = (usage: {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}) => ({
  ...(usage.inputTokens === undefined
    ? {}
    : { "model.completion.usage.input_tokens": usage.inputTokens }),
  ...(usage.outputTokens === undefined
    ? {}
    : { "model.completion.usage.output_tokens": usage.outputTokens }),
});

const completeWith =
  (modelsOf: (objectName: string) => PoolModelApi) =>
  (request: ModelCompletionRequest): Effect.Effect<string, ModelCompletionError> => {
    const provider = providerOf(request.modelSelection.instanceId);
    const attributes = {
      "model.completion.provider": provider ?? "unsupported",
      "model.completion.model": request.modelSelection.model,
    };
    return Effect.gen(function* () {
      if (provider === undefined) {
        return yield* fail(
          "unsupported-provider",
          `Provider ${request.modelSelection.instanceId} does not support model completion.`,
        );
      }
      const encoded = completionRequestFor(provider, request.modelSelection, request.prompt);
      if (encoded._tag === "unsupported-option") {
        return yield* fail(
          "unsupported-option",
          `Model option ${encoded.option} is not supported for ${provider} completion.`,
        );
      }
      if (encoded._tag === "invalid-options") {
        return yield* fail("invalid-options", encoded.reason);
      }

      const startedAt = yield* Clock.currentTimeMillis;
      const forward = yield* Effect.tryPromise({
        try: () =>
          modelsOf(request.pool.objectName).forwardModel(
            { userId: request.pool.userId },
            encoded.value.path,
            new Request(`https://pool.invalid${encoded.value.path}`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...encoded.value.headers,
              },
              body: requestBody(encoded.value.body),
            }),
          ),
        catch: () =>
          new ModelCompletionError({
            code: "pool-unavailable",
            reason: "The model pool could not be reached.",
          }),
      });
      yield* Effect.annotateCurrentSpan(
        "model.completion.latency_ms",
        (yield* Clock.currentTimeMillis) - startedAt,
      );
      if (forward._tag === "forwarded") {
        yield* Effect.annotateCurrentSpan("model.completion.upstream_ms", forward.upstreamMs);
      }
      if (forward._tag === "denied") {
        return yield* fail("pool-denied", forward.reason);
      }
      if (forward._tag === "failed") {
        return yield* fail(
          "pool-unavailable",
          forward.reason || "The model pool could not be reached.",
        );
      }
      if (!forward.response.ok) {
        yield* cancelBody(forward.response);
        return yield* Effect.fail(
          new ModelCompletionError({
            code: "http-error",
            reason: `The model provider returned HTTP ${forward.response.status}.`,
            status: forward.response.status,
          }),
        );
      }
      const body = yield* Effect.tryPromise({
        try: () => forward.response.json(),
        catch: () =>
          new ModelCompletionError({
            code: "invalid-response",
            reason: "The model provider returned invalid JSON.",
          }),
      });
      const decoded = decodeCompletionReply(provider, body);
      switch (decoded._tag) {
        case "text":
          if (decoded.usage !== undefined) {
            yield* Effect.annotateCurrentSpan(usageAttributes(decoded.usage));
          }
          return decoded.text;
        case "invalid":
          return yield* fail(
            "invalid-response",
            "The model provider returned an invalid response.",
          );
        case "failed":
          return yield* fail("provider-failed", "The model provider reported a failed response.");
        case "refused":
          return yield* fail(
            "provider-refused",
            "The model provider refused the completion request.",
          );
        case "truncated":
          return yield* fail("truncated", "The model provider truncated its response.");
        case "tool-call":
          return yield* fail(
            "tool-call",
            "The model returned a tool call; completion only supports text.",
          );
        case "no-text":
          return yield* fail("no-text", "The model provider returned no text.");
      }
    }).pipe(Effect.withSpan("ModelCompletion.complete", { attributes }));
  };

/** Runs text completion through the chosen pool without thread affinity or credentials. */
export const layer = (modelsOf: (objectName: string) => PoolModelApi) =>
  Layer.succeed(ModelCompletion, ModelCompletion.of({ complete: completeWith(modelsOf) }));
