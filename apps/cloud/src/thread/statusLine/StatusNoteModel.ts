import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  handleFor,
  type PoolObjectNamespace,
  poolObjectName,
  poolObjectStub,
} from "../../pool/PoolDirectory.ts";
import { type NoteModel, pickNoteModel } from "./statusNotePolicy.ts";

/**
 * One short model call for a runtime-written status note (`ThreadStatusNotes.ts`),
 * through the thread's own pool, so its owner's pool pays for it like for the
 * turn. The pool's CLIProxyAPI is asked in the format its harnesses speak:
 * Anthropic's Messages API (`/v1/messages`) for a Claude model, OpenAI's
 * Responses API (`/v1/responses`) for a Codex one, on the thread's own
 * account (`pool/threadAccounts.ts`). The model is the smallest the pool
 * serves (`pickNoteModel`). Never logs what it sends or gets back.
 */

export class StatusNoteModelError extends Schema.TaggedError<StatusNoteModelError>()(
  "StatusNoteModelError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}

export interface NoteRequest {
  readonly ownerId: string;
  readonly poolId: string;
  readonly threadId: string;
  /** The run's own model: the fallback when the pool serves nothing smaller. */
  readonly runModel: string;
  readonly system: string;
  readonly prompt: string;
}

export class StatusNoteModel extends Context.Service<
  StatusNoteModel,
  {
    /** The model's answer as text. */
    readonly complete: (request: NoteRequest) => Effect.Effect<string, StatusNoteModelError>;
  }
>()("@signalbox/cloud/thread/statusLine/StatusNoteModel") {}

/** Long enough for a small model's two lines; short enough to keep the alarm moving. */
const TIMEOUT = "45 seconds";
const MAX_TOKENS = 600;

const failed = (reason: string) => new StatusNoteModelError({ reason });

/** The path and body the pool's CLIProxyAPI takes for `choice`. */
export const noteRequestBody = (choice: NoteModel, request: NoteRequest) =>
  choice.api === "anthropic"
    ? {
        path: "/v1/messages",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: choice.model,
          max_tokens: MAX_TOKENS,
          system: request.system,
          messages: [{ role: "user", content: request.prompt }],
        }),
      }
    : {
        path: "/v1/responses",
        headers: { "content-type": "application/json" },
        // Codex accounts take neither stored responses nor a token cap.
        body: JSON.stringify({
          model: choice.model,
          instructions: request.system,
          input: [{ role: "user", content: request.prompt }],
          stream: false,
          store: false,
        }),
      };

const TextPart = Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) });
const decodeMessages = Schema.decodeUnknownOption(
  Schema.Struct({ content: Schema.Array(TextPart) }),
);
const decodeResponses = Schema.decodeUnknownOption(
  Schema.Struct({
    output_text: Schema.optional(Schema.String),
    output: Schema.optional(
      Schema.Array(Schema.Struct({ content: Schema.optional(Schema.Array(TextPart)) })),
    ),
  }),
);

/** The answer's text in either API's response; null when there is none. */
export const answerText = (api: NoteModel["api"], json: unknown): string | null => {
  const parts =
    api === "anthropic"
      ? Option.map(decodeMessages(json), (message) => message.content)
      : Option.map(decodeResponses(json), (response) =>
          response.output_text === undefined
            ? (response.output ?? []).flatMap((item) => item.content ?? [])
            : [{ type: "output_text", text: response.output_text }],
        );
  const text = Option.getOrElse(parts, () => [])
    .filter((part) => part.type === "text" || part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
  return text.trim() === "" ? null : text;
};

/** Through each pool's object, as the ModelGateway forwards a harness's requests. */
export const layerPools = (
  namespace: PoolObjectNamespace,
  options: { readonly localWorkerd: boolean },
) =>
  Layer.succeed(
    StatusNoteModel,
    StatusNoteModel.of({
      complete: (request) =>
        Effect.gen(function* () {
          const stub = poolObjectStub(
            namespace,
            poolObjectName(request.ownerId, request.poolId),
            options,
          );
          const actor = { userId: request.ownerId };
          const { models } = yield* handleFor(stub)
            .models(actor)
            .pipe(
              Effect.mapError((error) =>
                failed(
                  error._tag === "PoolRejectedError" ? error.reason : "The pool can't be reached.",
                ),
              ),
            );
          const choice = pickNoteModel(models, request.runModel);
          if (choice === null) return yield* failed("The pool serves no model for status notes.");
          const { path, headers, body } = noteRequestBody(choice, request);
          const reply = yield* Effect.tryPromise({
            try: () =>
              stub.forwardModel(
                actor,
                path,
                new Request(`https://pool.internal${path}`, { method: "POST", headers, body }),
                request.threadId,
              ),
            catch: () => failed("The pool can't be reached."),
          });
          if (reply._tag !== "forwarded") return yield* failed(reply.reason);
          const { response } = reply;
          if (!response.ok) {
            yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve());
            return yield* failed(`The pool answered HTTP ${response.status}.`);
          }
          const json = yield* Effect.tryPromise({
            try: () => response.json() as Promise<unknown>,
            catch: () => failed("The pool's answer isn't JSON."),
          });
          const text = answerText(choice.api, json);
          return text === null ? yield* failed("The model answered nothing.") : text;
        }).pipe(
          Effect.timeoutOrElse({
            duration: TIMEOUT,
            orElse: () => Effect.fail(failed("The model took too long.")),
          }),
        ),
    }),
  );

/** No model: every note is the agent's own. For tests that aren't about runtime notes. */
export const layerNone = Layer.succeed(
  StatusNoteModel,
  StatusNoteModel.of({ complete: () => Effect.fail(failed("No model in this test.")) }),
);
