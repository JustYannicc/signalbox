import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { type HttpClient, HttpClientRequest } from "effect/http";

import * as Evlog from "../observability/Evlog.ts";

/**
 * Executor's login service API (JustYannicc/executor#30), the one place a
 * sign-in's values come from: the person's own 1Password, linked to Executor
 * as a signed-in device, or a folder's source. Executor serves it only to
 * this service's own credential, and checks again that a person's device
 * answers only turns that person asked for.
 *
 * Over HTTPS with `EXECUTOR_LOGIN_SERVICE_TOKEN` today; executor#29 moves it
 * to a private service binding, behind this same interface. Values arrive
 * `Redacted` and stay in memory for the one submit that needs them.
 */

/** Whose credentials a turn may use (`CredentialScope` on Executor's side). */
export type CredentialScope =
  | { readonly kind: "person"; readonly person: string }
  | { readonly kind: "folder"; readonly folder: string };

/** One turn's ask: who requested it, whose credentials, for which page. */
export interface LoginTurn {
  readonly requester: string;
  readonly scope: CredentialScope;
  readonly origin: string;
}

export type LoginKind = "username" | "password" | "totp";

const LoginSummary = Schema.Struct({
  item: Schema.String,
  title: Schema.String,
  username: Schema.NullOr(Schema.String),
});
/** A login without its secrets: what the trail and the agent may name. */
export type LoginSummary = typeof LoginSummary.Type;

const Secret = Schema.RedactedFromValue(Schema.String);
const ResolvedLogin = Schema.Struct({
  item: Schema.Struct({ id: Schema.String, title: Schema.String }),
  username: Schema.optionalKey(Schema.String),
  password: Schema.optionalKey(Secret),
  totp: Schema.optionalKey(Secret),
});
export type ResolvedLogin = typeof ResolvedLogin.Type;

/** Why Executor gave no login, by its error's tag; `unavailable` may pass on a later try. */
const ExecutorLoginReason = Schema.Literals([
  "not-linked",
  "no-match",
  "not-owner",
  "no-folder-source",
  "unavailable",
]);
export type ExecutorLoginReason = typeof ExecutorLoginReason.Type;

export class ExecutorLoginError extends Schema.TaggedError<ExecutorLoginError>()(
  "ExecutorLoginError",
  { reason: ExecutorLoginReason, message: Schema.String },
) {}

export interface ExecutorLogins {
  /** The logins matching `origin`, best first, without values. */
  readonly logins: (
    turn: LoginTurn,
  ) => Effect.Effect<ReadonlyArray<LoginSummary>, ExecutorLoginError>;
  /** Exactly `kinds` of one login, `item` when named, for one submit. */
  readonly resolve: (
    turn: LoginTurn & {
      readonly kinds: readonly [LoginKind, ...Array<LoginKind>];
      readonly item: string;
    },
  ) => Effect.Effect<ResolvedLogin, ExecutorLoginError>;
}

const TIMEOUT = Duration.seconds(30);

const REASONS = new Map<string, ExecutorLoginReason>([
  ["OnePasswordNotLinked", "not-linked"],
  ["OnePasswordNoMatch", "no-match"],
  ["OnePasswordNotOwner", "not-owner"],
  ["OnePasswordNoFolderSource", "no-folder-source"],
]);

const decodeTag = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.String }));
const decodeLogins = Schema.decodeUnknownEffect(
  Schema.Struct({ logins: Schema.Array(LoginSummary) }),
);
const decodeResolved = Schema.decodeUnknownEffect(ResolvedLogin);

const unavailable = (message: string) => new ExecutorLoginError({ reason: "unavailable", message });

export const makeExecutorLogins = (
  client: HttpClient.HttpClient,
  options: { readonly url: string; readonly token: Redacted.Redacted<string> },
): ExecutorLogins => {
  const base = options.url.replace(/\/+$/, "");

  /**
   * POSTs `body`; Executor's refusal comes back by reason, everything else as
   * unavailable. Each call is its own wide event: the path and status, never the body.
   */
  const post = (path: string, body: unknown) =>
    client
      .execute(
        HttpClientRequest.post(`${base}${path}`).pipe(
          HttpClientRequest.bearerToken(options.token),
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(
        // Never the transport's error: it holds the request.
        Effect.mapError(() => unavailable("1Password couldn't be reached through Executor.")),
        Effect.flatMap((response) =>
          Effect.gen(function* () {
            yield* Evlog.annotate({ executor: { status: response.status } });
            const answer: unknown = yield* response.json.pipe(Effect.orElseSucceed(() => null));
            if (response.status >= 200 && response.status < 300) return answer;
            const decoded = decodeTag(answer);
            const tag = decoded._tag === "Some" ? decoded.value._tag : null;
            const reason = tag === null ? undefined : REASONS.get(tag);
            return yield* new ExecutorLoginError({
              reason: reason ?? "unavailable",
              message:
                reason !== undefined && tag !== null
                  ? tag
                  : `Executor answered ${response.status}${tag === null ? "" : ` (${tag})`}.`,
            });
          }),
        ),
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: TIMEOUT,
          orElse: () =>
            Effect.fail(unavailable(`Executor didn't answer within ${Duration.format(TIMEOUT)}.`)),
        }),
        Evlog.withUnit("executor.call", { executor: { path } }),
      );

  const malformed = () => unavailable("Executor sent an unreadable answer.");

  return {
    logins: (turn) =>
      post("/api/login-service/onepassword/logins", turn).pipe(
        Effect.flatMap((answer) => Effect.mapError(decodeLogins(answer), malformed)),
        Effect.map((answer) => answer.logins),
      ),
    resolve: (input) =>
      post("/api/login-service/onepassword/resolve", input).pipe(
        Effect.flatMap((answer) => Effect.mapError(decodeResolved(answer), malformed)),
      ),
  };
};

/** Executor with this cloud's login service credential, or none without one. */
export const executorLoginsFromEnv = (
  client: HttpClient.HttpClient,
  env: ExecutorLoginsEnv,
): ExecutorLogins | null => {
  const url = env.EXECUTOR_LOGIN_SERVICE_URL?.trim();
  const token = env.EXECUTOR_LOGIN_SERVICE_TOKEN?.trim();
  return url && token ? makeExecutorLogins(client, { url, token: Redacted.make(token) }) : null;
};

/** Worker settings the login service reads. Deploys pass an unset one as empty. */
export interface ExecutorLoginsEnv {
  readonly EXECUTOR_LOGIN_SERVICE_URL?: string;
  readonly EXECUTOR_LOGIN_SERVICE_TOKEN?: string;
}
