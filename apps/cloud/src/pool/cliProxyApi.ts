import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { PoolLinkInfo } from "@t3tools/contracts/accountHub";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * How a pool object talks to the CLIProxyAPI behind it: its own container,
 * or one the pool's admin runs. Both answer the same v8 management API
 * (`/v8/management/*`), so nothing above this module knows which one it is.
 * A pool backed by another cloud's pool link reads that pool through the
 * link's own API instead (`link`), which is versioned with Signalbox, not
 * with CLIProxyAPI.
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
  /**
   * Another cloud's pool link (`POOL_LINK_PATH`) rather than a CLIProxyAPI:
   * reads go to the link's own API, and both keys are its token.
   */
  readonly link: boolean;
}

/** The port the pool image's CLIProxyAPI listens on. */
export const CLI_PROXY_API_PORT = 8317;

/** Accounts a pool signs in through its CLIProxyAPI. */
export type PoolLoginProvider = "claude" | "codex";

const yamlString = (value: string) => JSON.stringify(value);

/**
 * What every managed pool's CLIProxyAPI runs with, in its v8 config tree:
 * seeded into a new pool's config and patched into an older one's
 * (`applyManagedConfig`). Usage statistics feed the pool's usage reads.
 */
export const MANAGED_CONFIG = {
  routing: {
    strategy: "round-robin",
    // A thread keeps one account so cached prompts and encrypted reasoning stay valid.
    "session-affinity": true,
  },
  observability: { usage: { "usage-statistics-enabled": true } },
} as const;

type ConfigTree = { readonly [key: string]: string | boolean | ConfigTree };

const yamlTree = (tree: ConfigTree, indent = ""): ReadonlyArray<string> =>
  Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "object"
      ? [`${indent}${key}:`, ...yamlTree(value, `${indent}  `)]
      : [`${indent}${key}: ${typeof value === "string" ? yamlString(value) : String(value)}`],
  );

/**
 * The config a managed pool's CLIProxyAPI starts with, written to its store
 * before the first start. CLIProxyAPI owns it from then on (it hashes the
 * management key in place, and keeps API keys added later), so it is only
 * ever seeded once; later changes go through the management API. Management
 * must allow remote calls: the pool object reaches the container over its
 * network, never its loopback.
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
    ...yamlTree(MANAGED_CONFIG),
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

/**
 * A harness's model request (`/v1/messages`, `/v1/responses`, `/v1/models`),
 * sent on with the pool's client key. The body streams through both ways.
 */
export const forwardModel = (endpoint: PoolEndpoint, path: string, request: Request) => {
  const headers = new Headers(request.headers);
  headers.delete("x-api-key");
  headers.set("authorization", `Bearer ${endpoint.clientKey}`);
  const init: RequestInit & { readonly duplex: "half" } = {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
    duplex: "half",
  };
  return send(endpoint, new Request(`${endpoint.baseUrl}${path}`, init));
};

/** A response's body as JSON, or `null` when it isn't JSON. */
const readJson = (endpoint: PoolEndpoint, response: Response) =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) =>
      new PoolBackendError({ detail: `${hostOf(endpoint)} broke off its answer.`, cause }),
  }).pipe(Effect.map((text) => Option.getOrNull(decodeJson(text))));

/**
 * A call with the management key, its body as JSON (`null` when it isn't).
 * A refused key fails with `refused`; any other status is the caller's.
 */
const call = (
  endpoint: PoolEndpoint,
  url: string,
  refused: string,
  options: { readonly method?: string; readonly body?: unknown } = {},
) =>
  Effect.gen(function* () {
    const { method = "GET", body } = options;
    const response = yield* send(
      endpoint,
      new Request(url, {
        method,
        headers: {
          authorization: `Bearer ${endpoint.managementKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: encodeJson(body) }),
      }),
    );
    // Not JSON: callers that need a body decode `null` and fail.
    const json = yield* readJson(endpoint, response);
    if (response.status === 401 || response.status === 403) {
      return yield* new PoolBackendError({ detail: `${hostOf(endpoint)} ${refused}` });
    }
    return { status: response.status, json };
  });

const management = (endpoint: PoolEndpoint, method: string, path: string, body?: unknown) =>
  call(endpoint, `${endpoint.baseUrl}/v8/management/${path}`, "refused the management key.", {
    method,
    body,
  });

/** Fails unless the call succeeded; `failed` says what didn't happen, after the host. */
const expectOk =
  (endpoint: PoolEndpoint, failed: (status: number) => string) =>
  (response: { readonly status: number }) =>
    response.status < 300
      ? Effect.void
      : Effect.fail(
          new PoolBackendError({ detail: `${hostOf(endpoint)} ${failed(response.status)}` }),
        );

const decodeOr = <A>(schema: Schema.Decoder<A>, detail: string) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (value: unknown) =>
    decode(value).pipe(Effect.mapError((cause) => new PoolBackendError({ detail, cause })));
};

/** A pool link's own read: the pool's name and accounts (`PoolLinkInfo`). */
const linkInfo = (endpoint: PoolEndpoint) =>
  call(endpoint, endpoint.baseUrl, "refused the pool link.").pipe(
    Effect.tap(expectOk(endpoint, (status) => `answered ${status} to the pool link.`)),
    Effect.flatMap((response) =>
      decodeOr(PoolLinkInfo, `${hostOf(endpoint)} returned an invalid pool.`)(response.json),
    ),
  );

/**
 * Confirms both keys work: management for admin calls, the client key for
 * model requests. A link is one key for both, and the pool behind it may be
 * asleep: asking for its models would wake it just to answer what reading
 * the pool has.
 */
export const checkKeys = (endpoint: PoolEndpoint) =>
  Effect.gen(function* () {
    if (endpoint.link) return yield* Effect.asVoid(linkInfo(endpoint));
    yield* management(endpoint, "GET", "config").pipe(
      Effect.flatMap(
        expectOk(endpoint, (status) =>
          status === 404
            ? "has no v8 management API. Signalbox needs CLIProxyAPI 8 or later."
            : `answered ${status} to a management call.`,
        ),
      ),
    );
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

const ModelList = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      owned_by: Schema.optional(Schema.String),
      created: Schema.optional(Schema.Number),
    }),
  ),
});

/**
 * A model the CLIProxyAPI serves. It lists only what its loaded, enabled
 * accounts can run, every provider together; `ownedBy` says whose it is
 * (`anthropic` for Claude accounts, `openai` for ChatGPT ones).
 */
export interface ServedModel {
  readonly id: string;
  readonly ownedBy: string;
  /** When the model came out, in epoch seconds, if the CLIProxyAPI knows. */
  readonly created: number | null;
}

/**
 * The models the CLIProxyAPI serves now (`GET /v1/models`). Asked without
 * `Anthropic-Version` or a `claude-cli` agent, which would get the
 * Anthropic-shaped list with other providers' models renamed.
 */
export const listModels = (endpoint: PoolEndpoint) =>
  Effect.gen(function* () {
    const response = yield* send(
      endpoint,
      new Request(`${endpoint.baseUrl}/v1/models`, {
        headers: { authorization: `Bearer ${endpoint.clientKey}` },
      }),
    );
    const json = yield* readJson(endpoint, response);
    if (response.status >= 300) {
      return yield* new PoolBackendError({
        detail: `${hostOf(endpoint)} answered ${response.status} to the model list.`,
      });
    }
    const decoded = yield* decodeOr(
      ModelList,
      `${hostOf(endpoint)} returned an invalid model list.`,
    )(json);
    return decoded.data.map((model): ServedModel => ({
      id: model.id,
      ownedBy: model.owned_by ?? "unknown",
      created: model.created && model.created > 0 ? model.created : null,
    }));
  });

const LoginStart = Schema.Struct({
  url: Schema.String,
  state: Schema.String,
  user_code: Schema.optional(Schema.String),
});
export type LoginStart = typeof LoginStart.Type;

export const startLogin = (endpoint: PoolEndpoint, provider: PoolLoginProvider) =>
  management(endpoint, "GET", `oauth/auth-url?provider=${provider}`).pipe(
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
  management(endpoint, "GET", `oauth/status?state=${encodeURIComponent(state)}`).pipe(
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
    const response = yield* management(endpoint, "POST", "oauth/callback", {
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
  management(endpoint, "DELETE", `oauth/session?state=${encodeURIComponent(state)}`).pipe(
    Effect.ignore,
  );

const AuthFiles = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      auth_index: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
      provider: Schema.optional(Schema.String),
      email: Schema.optional(Schema.String),
      disabled: Schema.optional(Schema.Boolean),
      status: Schema.optional(Schema.String),
      unavailable: Schema.optional(Schema.Boolean),
      next_retry_after: Schema.optional(Schema.Unknown),
      quota: Schema.optional(
        Schema.Struct({
          observed_at: Schema.optional(Schema.String),
          signals: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
        }),
      ),
      id_token: Schema.optional(
        Schema.Struct({ chatgpt_account_id: Schema.optional(Schema.String) }),
      ),
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

/**
 * What a backend says of an account's usage as it lists it. A CLIProxyAPI
 * keeps the rate-limit headers of the account's last response (`signals`,
 * empty until it has answered one since starting); another cloud's pool
 * link hands over the limits that pool read.
 */
export type ListedUsage =
  | {
      readonly _tag: "observed";
      /** What `requests/api-call` names the account by; null on a CLIProxyAPI too old to say. */
      readonly authIndex: string | null;
      readonly signals: Readonly<Record<string, string>>;
      /** Epoch millis of the response the signals came from, or null. */
      readonly observedAt: number | null;
      readonly chatgptAccountId: string | null;
    }
  | { readonly _tag: "reported"; readonly limits: ServerProviderUsageLimits | null };

export interface ListedAccount extends BackendAccount {
  readonly usage: ListedUsage;
}

const epochMillis = (iso: string | undefined) => {
  const at = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isFinite(at) && at > 0 ? at : null;
};

const listCredentials = (endpoint: PoolEndpoint) =>
  management(endpoint, "GET", "credentials").pipe(
    Effect.flatMap((response) =>
      decodeOr(AuthFiles, `${hostOf(endpoint)} returned an invalid account list.`)(response.json),
    ),
    Effect.map((decoded) =>
      decoded.files.map((file): ListedAccount => ({
        name: file.name,
        type: file.type ?? file.provider ?? "unknown",
        email: file.email ?? null,
        disabled: file.disabled ?? false,
        // The hub marks a dead refresh token as an error with no retry time.
        signedOut:
          file.status === "error" && file.unavailable === true && file.next_retry_after == null,
        usage: {
          _tag: "observed",
          authIndex: file.auth_index ?? null,
          signals: file.quota?.signals ?? {},
          observedAt: epochMillis(file.quota?.observed_at),
          chatgptAccountId: file.id_token?.chatgpt_account_id ?? null,
        },
      })),
    ),
  );

export const listAccounts = (endpoint: PoolEndpoint) =>
  endpoint.link
    ? linkInfo(endpoint).pipe(
        Effect.map((info) =>
          info.accounts.map((account): ListedAccount => ({
            name: account.name,
            type: account.type,
            email: account.email ?? null,
            disabled: account.disabled,
            signedOut: account.signedOut,
            usage: { _tag: "reported", limits: account.usageLimits ?? null },
          })),
        ),
      )
    : listCredentials(endpoint);

export const setAccountDisabled = (endpoint: PoolEndpoint, name: string, disabled: boolean) =>
  management(endpoint, "PATCH", "credentials/status", { name, disabled }).pipe(
    Effect.flatMap(
      expectOk(endpoint, () => `could not ${disabled ? "pause" : "resume"} the account.`),
    ),
  );

/** Saves a credential file into the CLIProxyAPI under `name`, as another hub stored it. */
export const uploadAccount = (
  endpoint: PoolEndpoint,
  name: string,
  credential: Readonly<Record<string, unknown>>,
) =>
  management(endpoint, "POST", `credentials?name=${encodeURIComponent(name)}`, credential).pipe(
    Effect.flatMap(expectOk(endpoint, () => "could not save the account.")),
  );

export const removeAccount = (endpoint: PoolEndpoint, name: string) =>
  management(endpoint, "DELETE", `credentials?name=${encodeURIComponent(name)}`).pipe(
    Effect.flatMap(expectOk(endpoint, () => "could not remove the account.")),
  );

/** Merges `MANAGED_CONFIG` into the CLIProxyAPI's config, which it saves to the pool's store. */
export const applyManagedConfig = (endpoint: PoolEndpoint) =>
  management(endpoint, "PATCH", "config", MANAGED_CONFIG).pipe(
    Effect.flatMap(expectOk(endpoint, (status) => `answered ${status} to a config change.`)),
  );

/** `MANAGED_CONFIG` as JSON, which a pool records once it is applied. */
export const MANAGED_CONFIG_JSON = encodeJson(MANAGED_CONFIG);

const ApiCallResponse = Schema.Struct({ status_code: Schema.Number, body: Schema.String });

/**
 * A GET the CLIProxyAPI makes upstream as the account (`requests/api-call`),
 * with `$TOKEN$` in `headers` standing for its access token. Answers the
 * upstream status and body, or fails when the CLIProxyAPI couldn't send it.
 */
export const accountGet = (
  endpoint: PoolEndpoint,
  authIndex: string,
  url: string,
  headers: Readonly<Record<string, string>>,
) =>
  management(endpoint, "POST", "requests/api-call", {
    auth_index: authIndex,
    method: "GET",
    url,
    header: headers,
  }).pipe(
    Effect.tap(expectOk(endpoint, (status) => `answered ${status} to an account request.`)),
    Effect.flatMap((response) =>
      decodeOr(
        ApiCallResponse,
        `${hostOf(endpoint)} returned an invalid account request answer.`,
      )(response.json),
    ),
    Effect.map((response) => ({ status: response.status_code, body: response.body })),
  );
