import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * How a pool object talks to the CLIProxyAPI behind it: its own container,
 * or one the pool's admin runs. Both answer the same management API
 * (`/v0/management/*`), so nothing above this module knows which one it is.
 * Mirrors the self-hosted hub's calls in
 * `apps/server/src/accountHub/accountHubManagement.ts`.
 */

export class PoolBackendError extends Schema.TaggedError<PoolBackendError>()("PoolBackendError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.detail;
  }
}

export interface PoolEndpoint {
  /** Sends a request to the CLIProxyAPI; managed pools wake their container here. */
  readonly fetch: (request: Request) => Promise<Response>;
  readonly baseUrl: string;
  /** `management.secret-key`. Never leaves the pool object. */
  readonly managementKey: string;
  /** One of its `access.api-keys`, which model requests carry. */
  readonly clientKey: string;
}

/** The port the pool image's CLIProxyAPI listens on. */
export const CLI_PROXY_API_PORT = 8317;

/** Accounts a pool signs in through its CLIProxyAPI, by the login route that adds them. */
const LOGIN_ROUTES = {
  claude: "anthropic-auth-url",
  codex: "codex-auth-url",
} as const;
export type PoolLoginProvider = keyof typeof LOGIN_ROUTES;

const yamlString = (value: string) => JSON.stringify(value);

/**
 * The config a managed pool's CLIProxyAPI starts with, written to its store
 * before the first start. CLIProxyAPI owns it from then on (it hashes the
 * management key in place, and keeps API keys added later), so it is only
 * ever seeded once. Management must allow remote calls: the pool object
 * reaches the container over its network, never its loopback.
 */
export const renderConfig = (keys: {
  readonly managementKey: string;
  readonly clientKey: string;
}) =>
  [
    "# Seeded by Signalbox Cloud when the pool was created.",
    "config-version: 8",
    "server:",
    '  host: ""',
    `  port: ${CLI_PROXY_API_PORT}`,
    "management:",
    "  allow-remote: true",
    `  secret-key: ${yamlString(keys.managementKey)}`,
    "  disable-control-panel: true",
    "access:",
    "  api-keys:",
    `    - ${yamlString(keys.clientKey)}`,
    "routing:",
    '  strategy: "round-robin"',
    // A thread keeps one account so cached prompts and encrypted reasoning stay valid.
    "  session-affinity: true",
    "",
  ].join("\n");

const hostOf = (endpoint: PoolEndpoint) => {
  try {
    return new URL(endpoint.baseUrl).host;
  } catch {
    return "The pool's CLIProxyAPI";
  }
};

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const send = (endpoint: PoolEndpoint, request: Request) =>
  Effect.tryPromise({
    try: () => endpoint.fetch(request),
    catch: (cause) =>
      new PoolBackendError({ detail: `${hostOf(endpoint)} could not be reached.`, cause }),
  });

const management = (endpoint: PoolEndpoint, method: string, path: string, body?: unknown) =>
  Effect.gen(function* () {
    const response = yield* send(
      endpoint,
      new Request(`${endpoint.baseUrl}/v0/management/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${endpoint.managementKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: encodeJson(body) }),
      }),
    );
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        new PoolBackendError({ detail: `${hostOf(endpoint)} broke off its answer.`, cause }),
    });
    if (response.status === 401 || response.status === 403) {
      return yield* new PoolBackendError({
        detail: `${hostOf(endpoint)} refused the management key.`,
      });
    }
    // Not JSON: callers that need a body decode `null` and fail.
    const json = Option.getOrNull(decodeJson(text));
    return { status: response.status, json };
  });

const decodeOr = <A>(schema: Schema.Decoder<A>, detail: string) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (value: unknown) =>
    decode(value).pipe(Effect.mapError((cause) => new PoolBackendError({ detail, cause })));
};

/** Confirms both keys work: management for admin calls, the client key for model requests. */
export const checkKeys = (endpoint: PoolEndpoint) =>
  Effect.gen(function* () {
    const config = yield* management(endpoint, "GET", "config");
    if (config.status >= 300) {
      return yield* new PoolBackendError({
        detail: `${hostOf(endpoint)} answered ${config.status} to a management call.`,
      });
    }
    const models = yield* send(
      endpoint,
      new Request(`${endpoint.baseUrl}/v1/models`, {
        headers: { authorization: `Bearer ${endpoint.clientKey}` },
      }),
    );
    yield* Effect.promise(() => models.body?.cancel() ?? Promise.resolve());
    if (models.status === 401 || models.status === 403) {
      return yield* new PoolBackendError({
        detail: `${hostOf(endpoint)} refused the client key.`,
      });
    }
  });

const LoginStart = Schema.Struct({
  url: Schema.String,
  state: Schema.String,
  user_code: Schema.optional(Schema.String),
});
export type LoginStart = typeof LoginStart.Type;

export const startLogin = (endpoint: PoolEndpoint, provider: PoolLoginProvider) =>
  management(endpoint, "GET", LOGIN_ROUTES[provider]).pipe(
    Effect.flatMap((response) =>
      decodeOr(LoginStart, "The pool's CLIProxyAPI could not start sign-in.")(response.json),
    ),
  );

const LoginStatus = Schema.Struct({
  status: Schema.String,
  error: Schema.optional(Schema.String),
});

export type LoginStatus =
  | { readonly status: "wait" | "ok" }
  | { readonly status: "error"; readonly error: string | null };

/** `wait` while the user signs in, `ok` once the account is saved, `error` otherwise. */
export const loginStatus = (
  endpoint: PoolEndpoint,
  state: string,
): Effect.Effect<LoginStatus, PoolBackendError> =>
  management(endpoint, "GET", `get-auth-status?state=${encodeURIComponent(state)}`).pipe(
    Effect.flatMap((response) =>
      decodeOr(LoginStatus, "The pool's CLIProxyAPI lost track of the sign-in.")(response.json),
    ),
    Effect.map((status) =>
      status.status === "ok" || status.status === "wait"
        ? ({ status: status.status } as const)
        : ({ status: "error", error: status.error ?? null } as const),
    ),
  );

/** Hands over the address the provider redirected to, for a login finished on another device. */
export const completeLogin = (endpoint: PoolEndpoint, redirectUrl: string) =>
  Effect.gen(function* () {
    // CLIProxyAPI reads the provider from the login's state, which the URL carries.
    const response = yield* management(endpoint, "POST", "oauth-callback", {
      redirect_url: redirectUrl,
    });
    const status =
      response.json !== null && typeof response.json === "object" && "status" in response.json
        ? response.json.status
        : null;
    if (response.status >= 300 || status === "error") {
      return yield* new PoolBackendError({
        detail: "That URL does not belong to this sign-in. Copy the full address and try again.",
      });
    }
  });

export const cancelLogin = (endpoint: PoolEndpoint, state: string) =>
  management(endpoint, "DELETE", `oauth-session?state=${encodeURIComponent(state)}`).pipe(
    Effect.ignore,
  );

const AuthFiles = Schema.Struct({
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
    }),
  ),
});

/** An account the CLIProxyAPI holds, as far as the pool needs to know it. */
export interface BackendAccount {
  readonly name: string;
  readonly type: string;
  readonly email: string | null;
  readonly disabled: boolean;
  /** The login died (revoked or expired refresh token); only a new sign-in fixes it. */
  readonly signedOut: boolean;
}

export const listAccounts = (endpoint: PoolEndpoint) =>
  management(endpoint, "GET", "auth-files").pipe(
    Effect.flatMap((response) =>
      decodeOr(AuthFiles, `${hostOf(endpoint)} returned an invalid account list.`)(response.json),
    ),
    Effect.map((decoded) =>
      decoded.files.map((file): BackendAccount => ({
        name: file.name,
        type: file.type ?? file.provider ?? "unknown",
        email: file.email ?? null,
        disabled: file.disabled ?? false,
        // The hub marks a dead refresh token as an error with no retry time.
        signedOut:
          file.status === "error" && file.unavailable === true && file.next_retry_after == null,
      })),
    ),
  );

const expectOk = (endpoint: PoolEndpoint, action: string) => (response: { status: number }) =>
  response.status < 300
    ? Effect.void
    : Effect.fail(
        new PoolBackendError({ detail: `${hostOf(endpoint)} could not ${action} the account.` }),
      );

export const setAccountDisabled = (endpoint: PoolEndpoint, name: string, disabled: boolean) =>
  management(endpoint, "PATCH", "auth-files/status", { name, disabled }).pipe(
    Effect.flatMap(expectOk(endpoint, disabled ? "pause" : "resume")),
  );

export const removeAccount = (endpoint: PoolEndpoint, name: string) =>
  management(endpoint, "DELETE", `auth-files?name=${encodeURIComponent(name)}`).pipe(
    Effect.flatMap(expectOk(endpoint, "remove")),
  );
