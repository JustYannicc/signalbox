import {
  SESSION_PATHS,
  type SessionAppend,
  type SessionAppendResult,
  type SessionStreams,
  sessionJson,
} from "@signalbox/runner-protocol/SessionProtocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

/**
 * A thread's machine talking to its session store on the cloud
 * (`SessionProtocol.ts`). Every call carries the current generation's session
 * token, read when the call is made. One attempt per call: the outbox above
 * it (`RunnerSessionOutbox.ts`) owns retrying, because it must never give up.
 */

export class SessionClientError extends Schema.TaggedError<SessionClientError>()(
  "SessionClientError",
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
  },
) {}

export interface SessionClient {
  readonly append: (input: SessionAppend) => Effect.Effect<SessionAppendResult, SessionClientError>;
  readonly streams: (
    prefix: string,
  ) => Effect.Effect<SessionStreams["streams"], SessionClientError>;
  readonly rows: (stream: string) => Effect.Effect<ReadonlyArray<string>, SessionClientError>;
}

/** Needs an `HttpClient` (`FetchHttpClient.layer` will do). `token` is null until a turn names one. */
export const makeSessionClient = Effect.fn("makeSessionClient")(function* (input: {
  readonly cloudUrl: string;
  readonly token: Effect.Effect<string | null>;
}) {
  const http = yield* HttpClient.HttpClient;
  const origin = input.cloudUrl.replace(/\/+$/, "");

  const send = <A>(
    request: HttpClientRequest.HttpClientRequest,
    label: string,
    decode: (text: string) => A,
  ) =>
    Effect.gen(function* () {
      const token = yield* input.token;
      if (token === null) {
        return yield* new SessionClientError({ message: `${label}: no session token yet` });
      }
      const response = yield* http
        .execute(HttpClientRequest.bearerToken(request, token))
        .pipe(
          Effect.mapError(
            (error) => new SessionClientError({ message: `${label}: ${error.message}` }),
          ),
        );
      const body = yield* response.text.pipe(
        Effect.mapError(
          (error) => new SessionClientError({ message: `${label}: ${error.message}` }),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* new SessionClientError({
          message: `${label} failed with HTTP ${response.status}: ${body.slice(0, 500)}`,
          status: response.status,
        });
      }
      return yield* Effect.try({
        try: () => decode(body),
        catch: () => new SessionClientError({ message: `${label}: malformed answer` }),
      });
    });

  return {
    append: (append) =>
      send(
        HttpClientRequest.post(`${origin}${SESSION_PATHS.append}`).pipe(
          HttpClientRequest.bodyText(sessionJson.append.encode(append), "application/json"),
        ),
        `saving ${append.stream}`,
        sessionJson.appendResult.decode,
      ),
    streams: (prefix) =>
      send(
        HttpClientRequest.get(`${origin}${SESSION_PATHS.streams}`).pipe(
          HttpClientRequest.setUrlParam("prefix", prefix),
        ),
        "listing session streams",
        (text) => sessionJson.streams.decode(text).streams,
      ),
    rows: (stream) =>
      Effect.gen(function* () {
        const rows: Array<string> = [];
        for (let more = true; more;) {
          const page = yield* send(
            HttpClientRequest.get(`${origin}${SESSION_PATHS.rows}`).pipe(
              HttpClientRequest.setUrlParams({ stream, from: String(rows.length) }),
            ),
            `reading ${stream}`,
            sessionJson.rows.decode,
          );
          rows.push(...page.rows);
          more = page.more && page.rows.length > 0;
        }
        return rows;
      }),
  } satisfies SessionClient;
});
