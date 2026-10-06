/**
 * Calls to the account hub's CLIProxyAPI management API (`/v8/management`).
 *
 * Only the OAuth login endpoints and credential status changes go through
 * HTTP; new credentials are written straight into the hub's auth directory,
 * which the hub watches and loads without a restart.
 *
 * @module accountHub/accountHubManagement
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

export class AccountHubError extends Schema.TaggedError<AccountHubError>()("AccountHubError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.detail;
  }
}

/** Where the running hub answers, and the keys Signalbox uses to talk to it. */
export interface AccountHubEndpoint {
  readonly baseUrl: string;
  /** Management API key (`/v8/management/*`). Never leaves the server. */
  readonly managementKey: string;
  /** Client key provider instances send as their bearer token. */
  readonly clientKey: string;
}

/** Logins the hub runs itself. ChatGPT is not here: Signalbox runs Sign in with ChatGPT. */
export type AccountHubOAuthProvider = "claude" | "xai" | "antigravity";

const AuthUrl = Schema.Struct({
  url: Schema.String,
  state: Schema.String,
  // Device flows (xAI) return a code the user enters on the provider's page.
  flow: Schema.optional(Schema.String),
  user_code: Schema.optional(Schema.String),
});
const Status = Schema.Struct({
  status: Schema.String,
  error: Schema.optional(Schema.String),
});

const decodeAuthUrl = Schema.decodeUnknownEffect(AuthUrl);
const decodeStatus = Schema.decodeUnknownEffect(Status);

const request = (
  endpoint: AccountHubEndpoint,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const url = `${endpoint.baseUrl}/v8/management/${path}`;
    const base = HttpClientRequest.make(method)(url).pipe(
      HttpClientRequest.bearerToken(endpoint.managementKey),
    );
    const response = yield* http.execute(
      body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, body),
    );
    return yield* response.json.pipe(Effect.map((json) => ({ status: response.status, json })));
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.mapError(
      (cause) => new AccountHubError({ detail: "The account hub did not answer.", cause }),
    ),
  );

const Credentials = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.optional(Schema.String),
      provider: Schema.optional(Schema.String),
      email: Schema.optional(Schema.String),
      disabled: Schema.optional(Schema.Boolean),
    }),
  ),
});

const decodeCredentials = Schema.decodeUnknownEffect(Credentials);

/** An account the hub holds, as far as Signalbox needs to know it. */
export interface AccountHubAccount {
  readonly name: string;
  readonly type: string;
  readonly email: string | null;
  readonly disabled: boolean;
}

export const listCredentials = Effect.fn("accountHub.listCredentials")(function* (
  endpoint: AccountHubEndpoint,
) {
  const response = yield* request(endpoint, "GET", "credentials");
  const decoded = yield* decodeCredentials(response.json).pipe(
    Effect.mapError(
      (cause) =>
        new AccountHubError({ detail: "The account hub returned an invalid account list.", cause }),
    ),
  );
  return decoded.files.map((file): AccountHubAccount => ({
    name: file.name,
    type: file.type ?? file.provider ?? "unknown",
    email: file.email ?? null,
    disabled: file.disabled ?? false,
  }));
});

/** Starts a provider OAuth login. `localCallback` lets the hub catch the redirect itself. */
export const startOAuthLogin = Effect.fn("accountHub.startOAuthLogin")(function* (
  endpoint: AccountHubEndpoint,
  provider: AccountHubOAuthProvider,
  localCallback: boolean,
) {
  const query = new URLSearchParams({ provider, ...(localCallback ? { is_webui: "true" } : {}) });
  const response = yield* request(endpoint, "GET", `oauth/auth-url?${query}`);
  return yield* decodeAuthUrl(response.json).pipe(
    Effect.mapError(
      (cause) => new AccountHubError({ detail: "The account hub could not start sign-in.", cause }),
    ),
  );
});

/** Hands the hub the URL the provider redirected to, for logins finished on another device. */
export const completeOAuthLogin = Effect.fn("accountHub.completeOAuthLogin")(function* (
  endpoint: AccountHubEndpoint,
  provider: AccountHubOAuthProvider,
  redirectUrl: string,
) {
  const response = yield* request(endpoint, "POST", "oauth/callback", {
    provider,
    redirect_url: redirectUrl,
  });
  const status = yield* decodeStatus(response.json).pipe(Effect.option);
  if (response.status >= 300 || (status._tag === "Some" && status.value.status === "error")) {
    return yield* new AccountHubError({
      detail: "That URL does not belong to this sign-in. Copy the full address and try again.",
    });
  }
});

/** Resolves when the hub has saved the account, or fails with what went wrong. */
export const awaitOAuthLogin = Effect.fn("accountHub.awaitOAuthLogin")(
  function* (endpoint: AccountHubEndpoint, state: string) {
    while (true) {
      const response = yield* request(
        endpoint,
        "GET",
        `oauth/status?state=${encodeURIComponent(state)}`,
      );
      const status = yield* decodeStatus(response.json).pipe(
        Effect.orElseSucceed(() => ({ status: "error", error: undefined })),
      );
      if (status.status === "ok") return;
      if (status.status !== "wait") {
        return yield* new AccountHubError({
          detail: status.error
            ? `Sign-in failed: ${status.error}.`
            : "Sign-in failed. Start again.",
        });
      }
      yield* Effect.sleep("1 second");
    }
    // The hub forgets a login after 30 minutes; never poll past that.
  },
  Effect.timeoutOrElse({
    duration: "30 minutes",
    orElse: () => Effect.fail(new AccountHubError({ detail: "Sign-in timed out. Start again." })),
  }),
);

export const cancelOAuthLogin = (endpoint: AccountHubEndpoint, state: string) =>
  request(endpoint, "DELETE", `oauth/session?state=${encodeURIComponent(state)}`).pipe(
    Effect.ignore,
  );
