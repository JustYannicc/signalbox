import { SESSION_PATHS, sessionJson } from "@signalbox/runner-protocol/SessionProtocol";
import type { ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

import { resolveAttachmentPath } from "../../attachmentStore.ts";

/**
 * The thread's attachments as files on this machine (`SessionProtocol.ts`):
 * before each turn, every screenshot or file the thread's messages hold is
 * downloaded where the adapters look for them (the server config's
 * `attachmentsDir`), unless it is already there. A new machine, after a sleep
 * or a move to a heavy one, so has every earlier attachment its resumed
 * session points at, not just the turn's own.
 *
 * Only the turn's own attachments must arrive: an earlier one that is gone is
 * logged and skipped, so it never stops the thread from working.
 */

export class RunnerAttachmentsError extends Schema.TaggedError<RunnerAttachmentsError>()(
  "RunnerAttachmentsError",
  { message: Schema.String, status: Schema.optional(Schema.Number), retryable: Schema.Boolean },
) {}

export interface RunnerAttachments {
  /** Brings every attachment of the thread with the turn's session token; `required` must arrive. */
  readonly bring: (
    token: string,
    required: ReadonlyArray<ChatAttachment>,
  ) => Effect.Effect<void, RunnerAttachmentsError>;
}

const RETRY = {
  times: 4,
  schedule: Schedule.exponential("250 millis"),
  while: (error: RunnerAttachmentsError) => error.retryable,
};

/** Needs an `HttpClient` (`FetchHttpClient.layer` will do), a `FileSystem` and a `Path`. */
export const makeRunnerAttachments = Effect.fn("makeRunnerAttachments")(function* (input: {
  readonly cloudUrl: string;
  readonly attachmentsDir: string;
}) {
  const http = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const origin = input.cloudUrl.replace(/\/+$/, "");
  const attachmentsDir = path.resolve(input.attachmentsDir);

  const failure = (label: string, retryable: boolean) => (error: { readonly message: string }) =>
    new RunnerAttachmentsError({ message: `${label}: ${error.message}`, retryable });

  /** Runs `use` on a 2xx answer to an authorized GET, retrying network failures and 5xx. */
  const get = <A>(
    url: string,
    token: string,
    label: string,
    use: (
      response: HttpClientResponse.HttpClientResponse,
    ) => Effect.Effect<A, RunnerAttachmentsError>,
  ) =>
    Effect.gen(function* () {
      const response = yield* http
        .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(token)))
        .pipe(Effect.mapError(failure(label, true)));
      if (response.status < 200 || response.status >= 300) {
        const detail = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        return yield* new RunnerAttachmentsError({
          message: `${label} failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
          status: response.status,
          retryable: response.status >= 500 || response.status === 429,
        });
      }
      return yield* use(response);
    }).pipe(Effect.retry(RETRY));

  /** Streams `attachment` to `target` through a staged file, checking its size before it lands. */
  const download = (attachment: ChatAttachment, target: string, token: string) => {
    const staged = `${target}.download`;
    const label = `downloading attachment ${attachment.id}`;
    return get(`${origin}${SESSION_PATHS.attachments}/${attachment.id}`, token, label, (response) =>
      Stream.run(response.stream, fs.sink(staged)).pipe(
        Effect.mapError(failure(label, true)),
        Effect.andThen(fs.stat(staged)),
        Effect.mapError(failure(label, true)),
        Effect.flatMap((info) =>
          Number(info.size) === attachment.sizeBytes
            ? fs.rename(staged, target).pipe(Effect.mapError(failure(label, false)))
            : Effect.fail(
                new RunnerAttachmentsError({
                  message: `${label}: ${info.size} bytes arrived, ${attachment.sizeBytes} expected`,
                  retryable: true,
                }),
              ),
        ),
      ),
    ).pipe(Effect.ensuring(fs.remove(staged, { force: true }).pipe(Effect.ignore)));
  };

  const bring: RunnerAttachments["bring"] = (token, required) =>
    Effect.gen(function* () {
      const { attachments } = yield* get(
        `${origin}${SESSION_PATHS.attachments}`,
        token,
        "listing attachments",
        (response) =>
          response.text.pipe(
            Effect.mapError(failure("listing attachments", true)),
            Effect.flatMap((text) =>
              Effect.try({
                try: () => sessionJson.attachments.decode(text),
                catch: () =>
                  new RunnerAttachmentsError({
                    message: "The thread sent a malformed attachment list.",
                    retryable: false,
                  }),
              }),
            ),
          ),
      );
      if (attachments.length === 0) return;
      const mustArrive = new Set(required.map((attachment) => attachment.id));
      yield* fs
        .makeDirectory(attachmentsDir, { recursive: true })
        .pipe(Effect.mapError(failure("attachments dir", false)));
      yield* Effect.forEach(
        attachments,
        (attachment) =>
          Effect.gen(function* () {
            const target = resolveAttachmentPath({ attachmentsDir, attachment });
            if (target === null || path.dirname(target) !== attachmentsDir) return;
            if (yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false))) return;
            yield* download(attachment, target, token).pipe(
              Effect.catchTags({
                RunnerAttachmentsError: (error) =>
                  mustArrive.has(attachment.id)
                    ? Effect.fail(error)
                    : Effect.logWarning("an earlier attachment did not arrive", {
                        attachmentId: attachment.id,
                        error: error.message,
                      }),
              }),
            );
          }),
        { concurrency: 4, discard: true },
      );
    });

  return { bring } satisfies RunnerAttachments;
});
