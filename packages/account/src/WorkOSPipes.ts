import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

/**
 * WorkOS Pipes: the user connects an outside account (GitHub, Slack, ...)
 * once, WorkOS keeps and refreshes its OAuth tokens, and the server asks for
 * a fresh access token whenever it acts as that user. Every call needs the
 * API key. `provider` is the integration's slug, e.g. `github`.
 *
 * Never log the response of `accessToken`: it is the user's token.
 */

export interface PipesConfig {
  readonly apiKey: Redacted.Redacted<string>;
  /** `https://api.workos.com` unless pointed elsewhere. */
  readonly apiBaseUrl: string;
}

export class WorkOSPipesError extends Schema.TaggedError<WorkOSPipesError>()("WorkOSPipesError", {
  operation: Schema.String,
  /** HTTP status, or 0 when no answer arrived. */
  status: Schema.Number,
  /** WorkOS's error message, when it sent one. Never carries a token. */
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return `WorkOS Pipes ${this.operation} failed (${this.status || "no response"})${this.detail ? `: ${this.detail}` : ""}.`;
  }
}

export type PipesToken =
  | {
      readonly _tag: "active";
      readonly token: Redacted.Redacted<string>;
      /** Epoch ms, or null when the provider's tokens don't expire. */
      readonly expiresAt: number | null;
      readonly missingScopes: ReadonlyArray<string>;
    }
  | {
      /** `not_installed` (never connected, or disconnected) or `needs_reauthorization`. */
      readonly _tag: "inactive";
      readonly reason: string;
    };

const AuthorizeBody = Schema.Struct({ url: Schema.String });
const TokenBody = Schema.Struct({
  active: Schema.Boolean,
  access_token: Schema.optional(
    Schema.Struct({
      access_token: Schema.String,
      expires_at: Schema.optional(Schema.NullOr(Schema.String)),
      missing_scopes: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  error: Schema.optional(Schema.String),
});
const ErrorBody = Schema.Struct({ message: Schema.optional(Schema.String) });

const request = (
  operation: string,
  config: PipesConfig,
  build: (url: (path: string) => URL) => HttpClientRequest.HttpClientRequest,
) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    return yield* httpClient
      .execute(
        build((path) => new URL(path, config.apiBaseUrl)).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(Redacted.value(config.apiKey)),
        ),
      )
      // The request carries the API key, so it stays out of the error.
      .pipe(Effect.mapError(() => new WorkOSPipesError({ operation, status: 0 })));
  });

const failFor = (operation: string, response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.schemaBodyJson(ErrorBody)(response).pipe(
    Effect.orElseSucceed((): typeof ErrorBody.Type => ({})),
    Effect.flatMap((body) =>
      Effect.fail(
        new WorkOSPipesError({
          operation,
          status: response.status,
          ...(body.message ? { detail: body.message } : {}),
        }),
      ),
    ),
  );

const decode = <A>(
  operation: string,
  schema: Schema.Codec<A, unknown>,
  response: HttpClientResponse.HttpClientResponse,
) =>
  HttpClientResponse.schemaBodyJson(schema)(response).pipe(
    // A token answer's body holds the token, so the decode error stays out of logs.
    Effect.mapError(() => new WorkOSPipesError({ operation, status: response.status })),
  );

/**
 * `POST /data-integrations/{provider}/authorize`: where to send the user to
 * connect `provider`. WorkOS brings them back to `returnTo` once it holds the
 * connection. Open the URL in the user's browser; never fetch it.
 */
export const authorizeUrl = Effect.fn("WorkOSPipes.authorizeUrl")(function* (
  config: PipesConfig,
  input: { readonly provider: string; readonly userId: string; readonly returnTo: string },
) {
  const operation = "authorize";
  const response = yield* request(operation, config, (url) =>
    HttpClientRequest.post(
      url(`/data-integrations/${encodeURIComponent(input.provider)}/authorize`),
    ).pipe(HttpClientRequest.bodyJsonUnsafe({ user_id: input.userId, return_to: input.returnTo })),
  );
  if (response.status < 200 || response.status >= 300) return yield* failFor(operation, response);
  return (yield* decode(operation, AuthorizeBody, response)).url;
});

/**
 * `POST /data-integrations/{provider}/token`: a fresh access token for the
 * user's connected account, refreshed by WorkOS when it expired.
 */
export const accessToken = Effect.fn("WorkOSPipes.accessToken")(function* (
  config: PipesConfig,
  input: { readonly provider: string; readonly userId: string },
) {
  const operation = "token";
  const response = yield* request(operation, config, (url) =>
    HttpClientRequest.post(
      url(`/data-integrations/${encodeURIComponent(input.provider)}/token`),
    ).pipe(HttpClientRequest.bodyJsonUnsafe({ user_id: input.userId })),
  );
  if (response.status < 200 || response.status >= 300) return yield* failFor(operation, response);
  const body = yield* decode(operation, TokenBody, response);
  if (!body.active || body.access_token === undefined) {
    return { _tag: "inactive", reason: body.error ?? "not_installed" } satisfies PipesToken;
  }
  const expiresAt = body.access_token.expires_at
    ? Date.parse(body.access_token.expires_at)
    : Number.NaN;
  return {
    _tag: "active",
    token: Redacted.make(body.access_token.access_token),
    expiresAt: Number.isNaN(expiresAt) ? null : expiresAt,
    missingScopes: body.access_token.missing_scopes ?? [],
  } satisfies PipesToken;
});

/**
 * `DELETE /user_management/users/{userId}/connected_accounts/{provider}`:
 * forgets the user's connected account and its tokens. Done when there was none.
 */
export const disconnect = Effect.fn("WorkOSPipes.disconnect")(function* (
  config: PipesConfig,
  input: { readonly provider: string; readonly userId: string },
) {
  const operation = "disconnect";
  const response = yield* request(operation, config, (url) =>
    HttpClientRequest.delete(
      url(
        `/user_management/users/${encodeURIComponent(input.userId)}/connected_accounts/${encodeURIComponent(input.provider)}`,
      ),
    ),
  );
  if (response.status === 404) return;
  if (response.status < 200 || response.status >= 300) return yield* failFor(operation, response);
});
