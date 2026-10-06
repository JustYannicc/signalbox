/**
 * Calls to the account hub's CLIProxyAPI management API. They use the `/v0`
 * routes: CLIProxyAPI 8 still serves them, and older instances people
 * already run serve nothing else.
 *
 * Only the OAuth login endpoints and credential status changes go through
 * HTTP; new credentials are written straight into the hub's auth directory,
 * which the hub watches and loads without a restart.
 *
 * @module accountHub/accountHubManagement
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

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
  /** Management API key (`/v0/management/*`). Never leaves the server. */
  readonly managementKey: string;
  /** Client key provider instances send as their bearer token. */
  readonly clientKey: string;
}

/**
 * Logins the hub runs itself. New ChatGPT accounts use Signalbox's Sign in with
 * ChatGPT; `codex` is the hub's own Codex login, for signing existing Codex
 * accounts in again on hubs without Signalbox's plugin.
 */
export type AccountHubOAuthProvider = "claude" | "xai" | "antigravity" | "codex";

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

type ManagementEndpoint = Pick<AccountHubEndpoint, "baseUrl" | "managementKey">;

const hostOf = (endpoint: ManagementEndpoint) =>
  URL.canParse(endpoint.baseUrl) ? new URL(endpoint.baseUrl).host : endpoint.baseUrl;

// Node puts the useful bit (CERT_HAS_EXPIRED, ECONNREFUSED, ...) a few causes deep.
const networkCode = (cause: unknown): string | null => {
  for (let current = cause, depth = 0; current && depth < 6; depth++) {
    if (typeof current !== "object") return null;
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : null;
  }
  return null;
};

const unreachable = (endpoint: ManagementEndpoint, cause: unknown) => {
  const code = networkCode(cause);
  const host = hostOf(endpoint);
  return new AccountHubError({
    detail:
      code === "ERR_TLS_CERT_ALTNAME_INVALID"
        ? `Could not reach ${host}: its TLS certificate is for a different host.`
        : code?.includes("CERT") || code?.includes("SIGNATURE")
          ? `Could not reach ${host}: its TLS certificate is not trusted (${code}).`
          : `Could not reach ${host}${code ? ` (${code})` : ""}.`,
    cause,
  });
};

/**
 * One management call. Network, TLS, timeout, and rejected-key failures all
 * surface here with the host named, so every caller reports the real problem.
 */
const send = (
  endpoint: ManagementEndpoint,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  withBody: (
    request: HttpClientRequest.HttpClientRequest,
  ) => HttpClientRequest.HttpClientRequest = (request) => request,
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http
      .execute(
        HttpClientRequest.make(method)(`${endpoint.baseUrl}/v0/management/${path}`).pipe(
          HttpClientRequest.bearerToken(endpoint.managementKey),
          withBody,
        ),
      )
      .pipe(
        Effect.mapError((cause) => unreachable(endpoint, cause)),
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () =>
            Effect.fail(
              new AccountHubError({
                detail: `${hostOf(endpoint)} did not answer within 15 seconds.`,
              }),
            ),
        }),
      );
    if (response.status === 401 || response.status === 403) {
      return yield* new AccountHubError({
        detail: `${hostOf(endpoint)} rejected the management key.`,
      });
    }
    return response;
  });

const request = (
  endpoint: ManagementEndpoint,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
) =>
  Effect.gen(function* () {
    const response = yield* send(
      endpoint,
      method,
      path,
      body === undefined ? undefined : (request) => HttpClientRequest.bodyJsonUnsafe(request, body),
    );
    const json = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new AccountHubError({
            detail: `${hostOf(endpoint)} did not answer like a CLIProxyAPI (HTTP ${response.status}).`,
            cause,
          }),
      ),
    );
    return { status: response.status, json };
  });

const Credentials = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.optional(Schema.String),
      provider: Schema.optional(Schema.String),
      email: Schema.optional(Schema.String),
      disabled: Schema.optional(Schema.Boolean),
      status: Schema.optional(Schema.String),
      unavailable: Schema.optional(Schema.Boolean),
      next_retry_after: Schema.optional(Schema.Unknown),
      id_token: Schema.optional(
        Schema.Struct({ chatgpt_account_id: Schema.optional(Schema.String) }),
      ),
    }),
  ),
});

const decodeCredentials = Schema.decodeUnknownEffect(Credentials);

/**
 * The hub marks an account whose refresh token died as an error with no retry
 * time; a cooldown always carries `next_retry_after`.
 */
export const isSignedOutAuthFile = (file: {
  readonly status?: string | undefined;
  readonly unavailable?: boolean | undefined;
  readonly next_retry_after?: unknown;
}) => file.status === "error" && file.unavailable === true && file.next_retry_after == null;

/** An account the hub holds, as far as Signalbox needs to know it. */
export interface AccountHubAccount {
  readonly name: string;
  readonly type: string;
  readonly email: string | null;
  readonly disabled: boolean;
  /** The login died (revoked or expired refresh token); only a new sign-in fixes it. */
  readonly signedOut: boolean;
  /** The ChatGPT workspace, when known; one email can own several. */
  readonly workspaceId: string | null;
}

export const listCredentials = Effect.fn("accountHub.listCredentials")(function* (
  endpoint: ManagementEndpoint,
) {
  const response = yield* request(endpoint, "GET", "auth-files");
  const decoded = yield* decodeCredentials(response.json).pipe(
    Effect.mapError(
      (cause) =>
        new AccountHubError({
          detail: `${hostOf(endpoint)} returned an invalid account list.`,
          cause,
        }),
    ),
  );
  return decoded.files.map((file): AccountHubAccount => ({
    name: file.name,
    type: file.type ?? file.provider ?? "unknown",
    email: file.email ?? null,
    disabled: file.disabled ?? false,
    signedOut: isSignedOutAuthFile(file),
    workspaceId: file.id_token?.chatgpt_account_id ?? null,
  }));
});

const LOGIN_ROUTE: Record<AccountHubOAuthProvider, string> = {
  claude: "anthropic-auth-url",
  xai: "xai-auth-url",
  antigravity: "antigravity-auth-url",
  codex: "codex-auth-url",
};

/** Whether the hub can run the login for credentials of `type` itself. */
export const isHubLoginProvider = (type: string): type is AccountHubOAuthProvider =>
  Object.hasOwn(LOGIN_ROUTE, type);

/** Starts a provider OAuth login. `localCallback` lets the hub catch the redirect itself. */
export const startOAuthLogin = Effect.fn("accountHub.startOAuthLogin")(function* (
  endpoint: AccountHubEndpoint,
  provider: AccountHubOAuthProvider,
  localCallback: boolean,
) {
  const query = localCallback ? "?is_webui=true" : "";
  const response = yield* request(endpoint, "GET", `${LOGIN_ROUTE[provider]}${query}`);
  return yield* decodeAuthUrl(response.json).pipe(
    Effect.mapError(
      (cause) => new AccountHubError({ detail: "The account hub could not start sign-in.", cause }),
    ),
  );
});

/** Hands the hub the URL the provider redirected to, for logins finished on another device. */
export const completeOAuthLogin = Effect.fn("accountHub.completeOAuthLogin")(function* (
  endpoint: AccountHubEndpoint,
  redirectUrl: string,
) {
  // The hub reads the provider from the login's state, which the URL carries.
  const response = yield* request(endpoint, "POST", "oauth-callback", {
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
        `get-auth-status?state=${encodeURIComponent(state)}`,
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
  request(endpoint, "DELETE", `oauth-session?state=${encodeURIComponent(state)}`).pipe(
    Effect.ignore,
  );

/** The raw credential file, exactly as the hub stores it. */
export const downloadCredential = Effect.fn("accountHub.downloadCredential")(function* (
  endpoint: ManagementEndpoint,
  name: string,
) {
  const response = yield* send(
    endpoint,
    "GET",
    `auth-files/download?name=${encodeURIComponent(name)}`,
  );
  if (response.status !== 200) {
    return yield* new AccountHubError({ detail: `Could not download ${name}.` });
  }
  return yield* response.text.pipe(
    Effect.mapError(
      (cause) => new AccountHubError({ detail: `Could not download ${name}.`, cause }),
    ),
  );
});

/** Writes a credential file into a hub that Signalbox does not run. */
export const uploadCredential = Effect.fn("accountHub.uploadCredential")(function* (
  endpoint: ManagementEndpoint,
  name: string,
  content: string,
) {
  const response = yield* send(
    endpoint,
    "POST",
    `auth-files?name=${encodeURIComponent(name)}`,
    HttpClientRequest.bodyText(content, "application/json"),
  );
  if (response.status !== 200) {
    return yield* new AccountHubError({ detail: `${hostOf(endpoint)} refused ${name}.` });
  }
});

export const deleteCredential = Effect.fn("accountHub.deleteCredential")(function* (
  endpoint: ManagementEndpoint,
  name: string,
) {
  const response = yield* send(endpoint, "DELETE", `auth-files?name=${encodeURIComponent(name)}`);
  if (response.status !== 200) {
    return yield* new AccountHubError({
      detail: `Could not remove ${name} from ${hostOf(endpoint)}.`,
    });
  }
});
