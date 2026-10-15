import { ThreadKind } from "@t3tools/contracts/signalboxThreadKinds";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

/**
 * Tells a chat from a task by a thread's first message (#46), with a
 * semantic decision model: Jev (TypeSafe) or OpenAI's Decisions API. The
 * question is word for word what the classifier benchmark measured
 * (`/tmp/kind-eval/scripts/bench.py`); change it only with a new run of it.
 *
 * Never fails and never waits more than `TIMEOUT_MS`: anything but an answer
 * is none, and the thread stays a task until the user flips it. Spans and
 * logs carry the provider, model, outcome, tokens and latency, never the
 * title or message.
 */

const INSTRUCTIONS =
  "A person started a thread with an AI agent. `title` is the thread title and `firstMessage` is what they asked. Is this thread a task or a chat?";
const CRITERIA: Record<ThreadKind, string> = {
  task: "Committed work: the person wants the agent to get something done that produces a change or deliverable, such as implementing or fixing code, setting something up, or creating, sending or publishing an artifact. It is finished when the deliverable exists.",
  chat: "Non-committal thinking: a question, research, exploring options, brainstorming, discussing a design, or asking for an explanation or opinion, without asking for the work to be carried out yet. It is finished when the person understands.",
};
const MAX_CHARS = 4000;
const TIMEOUT_MS = 3000;

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const OPENAI_DECISIONS_URL = "https://api.openai.com/v1/decisions";

export interface KindQuestion {
  readonly title: string;
  readonly firstMessage: string;
}

export class KindClassifier extends Context.Service<
  KindClassifier,
  { readonly classify: (question: KindQuestion) => Effect.Effect<Option.Option<ThreadKind>> }
>()("@signalbox/cloud/threadKinds/KindClassifier") {}

export type KindProvider = "jev" | "openai";

export interface KindClassifierSettings {
  readonly provider: KindProvider;
  readonly apiKey: Redacted.Redacted<string>;
}

/** Worker vars and secrets the classifier reads. Deploys pass unset secrets as empty. */
export interface KindClassifierEnv {
  /** `jev` or `openai`; unset picks whichever key is set, Jev first. */
  readonly THREAD_KIND_CLASSIFIER?: string;
  readonly TYPESAFE_API_KEY?: string;
  readonly OPENAI_API_KEY?: string;
}

/** The provider to ask, or null when none is configured: then nothing is classified. */
export const settingsFromEnv = (env: KindClassifierEnv): KindClassifierSettings | null => {
  const keys: Record<KindProvider, string | undefined> = {
    jev: env.TYPESAFE_API_KEY,
    openai: env.OPENAI_API_KEY,
  };
  const chosen = env.THREAD_KIND_CLASSIFIER?.trim();
  const provider: KindProvider | undefined =
    chosen === "jev" || chosen === "openai"
      ? chosen
      : keys.jev
        ? "jev"
        : keys.openai
          ? "openai"
          : undefined;
  const apiKey = provider === undefined ? undefined : keys[provider];
  return provider === undefined || !apiKey ? null : { provider, apiKey: Redacted.make(apiKey) };
};

/** The first `max` characters, never splitting one, as the benchmark's Python slice. */
const firstChars = (text: string, max: number) => {
  let taken = "";
  let count = 0;
  for (const char of text) {
    if (count++ === max) break;
    taken += char;
  }
  return taken;
};

const Usage = Schema.Struct({ input_tokens: Schema.Number });

const JevAnswer = Schema.Struct({
  model: Schema.String,
  answers: Schema.Struct({
    kind: Schema.Struct({ choice: ThreadKind, confidence: Schema.optional(Schema.Number) }),
  }),
  usage: Usage,
});

const OpenAIAnswer = Schema.Struct({
  model: Schema.String,
  // One question, one answer.
  answers: Schema.NonEmptyArray(
    Schema.Union([
      Schema.Struct({
        type: Schema.Literal("choice"),
        choice: ThreadKind,
        confidence: Schema.optional(Schema.Number),
      }),
      Schema.Struct({ type: Schema.Literal("refusal") }),
    ]),
  ),
  usage: Usage,
});

/** One provider's answer: null when the model declined to choose. */
interface Answer {
  readonly kind: ThreadKind | null;
  readonly model: string;
  readonly inputTokens: number;
  readonly confidence?: number | undefined;
}

const requestFor = (settings: KindClassifierSettings, question: KindQuestion) => {
  const state = {
    title: question.title,
    firstMessage: firstChars(question.firstMessage, MAX_CHARS),
  };
  const body =
    settings.provider === "jev"
      ? {
          model: "jev-latest",
          state,
          questions: { kind: { type: "choice", instructions: INSTRUCTIONS, criteria: CRITERIA } },
        }
      : {
          model: "gpt-6-luna",
          input: JSON.stringify(state),
          questions: [
            {
              type: "choice",
              name: "kind",
              instructions: INSTRUCTIONS,
              choices: (["task", "chat"] as const).map((value) => ({
                value,
                description: CRITERIA[value],
              })),
            },
          ],
        };
  return HttpClientRequest.post(settings.provider === "jev" ? JEV_URL : OPENAI_DECISIONS_URL).pipe(
    HttpClientRequest.bearerToken(Redacted.value(settings.apiKey)),
    HttpClientRequest.bodyJsonUnsafe(body),
  );
};

const decodeJev = Schema.decodeUnknownEffect(JevAnswer);
const decodeOpenAI = Schema.decodeUnknownEffect(OpenAIAnswer);

const answerOf = (
  provider: KindProvider,
  json: unknown,
): Effect.Effect<Answer, Schema.SchemaError> =>
  provider === "jev"
    ? Effect.map(decodeJev(json), (data) => ({
        kind: data.answers.kind.choice,
        model: data.model,
        inputTokens: data.usage.input_tokens,
        confidence: data.answers.kind.confidence,
      }))
    : Effect.map(decodeOpenAI(json), (data) => {
        const [answer] = data.answers;
        return {
          kind: answer.type === "choice" ? answer.choice : null,
          model: data.model,
          inputTokens: data.usage.input_tokens,
          confidence: answer.type === "choice" ? answer.confidence : undefined,
        };
      });

/** Why a call failed, without anything it carried. */
const failureOf = (error: { readonly _tag: string }) => {
  if (error._tag !== "HttpClientError" || !("reason" in error)) return error._tag;
  const reason = error.reason as { readonly _tag: string; readonly response?: { status: number } };
  return reason.response === undefined ? reason._tag : `${reason._tag} ${reason.response.status}`;
};

/** Asks `settings.provider`; needs an `HttpClient`. */
export const layer = (settings: KindClassifierSettings) =>
  Layer.effect(
    KindClassifier,
    Effect.gen(function* () {
      const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const { provider } = settings;
      const classify = (question: KindQuestion) =>
        Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis;
          const asked = yield* http.execute(requestFor(settings, question)).pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap((json) => answerOf(provider, json)),
            Effect.timeoutOption(TIMEOUT_MS),
            Effect.result,
          );
          const latencyMs = (yield* Clock.currentTimeMillis) - started;
          const outcome =
            asked._tag === "Failure"
              ? "error"
              : Option.isNone(asked.success)
                ? "timeout"
                : (asked.success.value.kind ?? "refusal");
          const answer =
            asked._tag === "Success" && Option.isSome(asked.success) ? asked.success.value : null;
          yield* Effect.annotateCurrentSpan({
            "thread_kind.outcome": outcome,
            "thread_kind.latency_ms": latencyMs,
            ...(answer === null
              ? {}
              : {
                  "thread_kind.model": answer.model,
                  "thread_kind.input_tokens": answer.inputTokens,
                  ...(answer.confidence === undefined
                    ? {}
                    : { "thread_kind.confidence": answer.confidence }),
                }),
          });
          if (asked._tag === "Failure" || answer === null) {
            yield* Effect.logWarning("thread kind classification failed", {
              provider,
              outcome,
              latencyMs,
              ...(asked._tag === "Failure" ? { reason: failureOf(asked.failure) } : {}),
            });
          }
          return Option.fromNullishOr(answer?.kind);
        }).pipe(
          Effect.withSpan("signalbox.thread_kind.classify", {
            attributes: { "thread_kind.provider": provider },
          }),
        );
      return KindClassifier.of({ classify });
    }),
  );

/** No provider configured: nothing is classified, so new threads stay tasks. */
export const layerNone = Layer.succeed(
  KindClassifier,
  KindClassifier.of({ classify: () => Effect.succeedNone }),
);

/** The configured provider, or none. */
export const layerFromEnv = (env: KindClassifierEnv) => {
  const settings = settingsFromEnv(env);
  return settings === null ? layerNone : layer(settings);
};
