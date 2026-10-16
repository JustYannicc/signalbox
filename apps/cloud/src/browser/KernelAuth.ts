import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type HttpClient, HttpClientRequest } from "effect/http";

import { type KernelApiError, type KernelOptions, makeKernelRequests } from "./KernelApi.ts";

/**
 * The parts of Kernel's Managed Auth (https://www.kernel.sh/docs/auth) the
 * login service drives (#576): one connection per profile and site, its
 * login flow, and answering the flow's pauses programmatically. Kernel has
 * no webhooks, so a flow is followed by reading its connection. Only the
 * fields used here are decoded; Kernel adds fields freely.
 *
 * `submit`'s body carries 1Password values: it is never logged, and its
 * errors carry only Kernel's code and words.
 */

const Text = Schema.optional(Schema.NullOr(Schema.String));

const AuthField = Schema.Struct({
  id: Schema.String,
  /** `identifier`, `password`, `code`, `totp_code`, `totp_secret` or `text`. */
  type: Schema.String,
  /** `missing`, or `rejected` when the site refused the last value. */
  reason: Text,
  label: Text,
});
export type AuthField = typeof AuthField.Type;

const AuthChoice = Schema.Struct({
  id: Schema.String,
  /** `mfa_method`, `sso_provider`, `sign_in_method`, `auth_method`, `account`, … */
  type: Schema.String,
  label: Schema.String,
  /** For an MFA route: `password`, `totp`, `email`, `sms`, `push`, `passkey`, … */
  mfa_type: Text,
  description: Text,
  display_text: Text,
});
export type AuthChoice = typeof AuthChoice.Type;

const AuthConnection = Schema.Struct({
  id: Schema.String,
  domain: Schema.String,
  profile_name: Schema.optional(Schema.String),
  /** The last health check's verdict: `AUTHENTICATED` or `NEEDS_AUTH`. */
  status: Schema.String,
  save_credentials: Schema.Boolean,
  /** `IN_PROGRESS`, `SUCCESS`, `FAILED`, `EXPIRED` or `CANCELED`; null without a flow. */
  flow_status: Text,
  /** `DISCOVERING`, `AWAITING_INPUT`, `AWAITING_EXTERNAL_ACTION`, `SUBMITTING`, `COMPLETED`. */
  flow_step: Text,
  /** The current pause; a submit names it, and Kernel refuses a stale one. */
  interaction_id: Text,
  fields: Schema.optional(Schema.NullOr(Schema.Array(AuthField))),
  choices: Schema.optional(Schema.NullOr(Schema.Array(AuthChoice))),
  error_code: Text,
  error_message: Text,
  website_error: Text,
  external_action_message: Text,
  /** The SSO provider a flow went through, which the login service never follows. */
  sso_provider: Text,
  /** Why health checks can't verify it, e.g. `no_auth_check_url` before a first login. */
  health_check_unavailable_reason: Text,
});
export type AuthConnection = typeof AuthConnection.Type;

/** `POST /auth/connections` as the login service asks for it. */
export interface AuthConnectionRequest {
  readonly domain: string;
  readonly profile_name: string;
  /** Always false: values come from 1Password at each login, never from Kernel. */
  readonly save_credentials: false;
  /** Where Kernel may type values: the site, besides the SSO providers it allows by default. */
  readonly allowed_domains: ReadonlyArray<string>;
  /** Kernel's checks flip a logged-out connection to `NEEDS_AUTH`, which the login service answers. */
  readonly health_checks: true;
  readonly record_session: false;
}

/** One answer to the flow's current pause. */
export type AuthSubmission =
  | { readonly interaction_id: string; readonly field_values: Readonly<Record<string, string>> }
  | { readonly interaction_id: string; readonly selected_choice_id: string };

export interface KernelAuth {
  /** The profile's connection for the site, created when it has none. */
  readonly ensureConnection: (
    request: AuthConnectionRequest,
  ) => Effect.Effect<AuthConnection, KernelApiError>;
  /** Null once Kernel deleted it. */
  readonly getConnection: (id: string) => Effect.Effect<AuthConnection | null, KernelApiError>;
  /** Turns credential saving off on a connection made before, or by someone else. */
  readonly stopSavingCredentials: (id: string) => Effect.Effect<void, KernelApiError>;
  /** Starts a login; one already running is followed instead, since a new one would cancel it. */
  readonly login: (id: string) => Effect.Effect<void, KernelApiError>;
  readonly submit: (id: string, answer: AuthSubmission) => Effect.Effect<void, KernelApiError>;
}

export const makeKernelAuth = (
  client: HttpClient.HttpClient,
  options: KernelOptions,
): KernelAuth => {
  const { url, send, decoded } = makeKernelRequests(client, options);
  const connectionPath = (id: string, rest = "") =>
    url(`/auth/connections/${encodeURIComponent(id)}${rest}`);
  const status = (code: number) => (error: KernelApiError) => error.status === code;

  const find = (request: AuthConnectionRequest) =>
    send(
      "listAuthConnections",
      HttpClientRequest.get(url("/auth/connections")).pipe(
        HttpClientRequest.setUrlParams({
          profile_name: request.profile_name,
          domain: request.domain,
        }),
      ),
    ).pipe(
      Effect.flatMap(decoded("listAuthConnections", Schema.Array(AuthConnection))),
      // Only this profile's: another person's connection for the site would log them in instead.
      Effect.map((connections) =>
        connections.find(
          (each) => each.domain === request.domain && each.profile_name === request.profile_name,
        ),
      ),
    );

  return {
    ensureConnection: (request) =>
      send(
        "createAuthConnection",
        HttpClientRequest.post(url("/auth/connections")).pipe(
          HttpClientRequest.bodyJsonUnsafe(request),
        ),
      ).pipe(
        Effect.flatMap(decoded("createAuthConnection", AuthConnection)),
        // The profile has one for the site already: that's the one.
        Effect.catchIf(status(409), (error) =>
          Effect.flatMap(find(request), (found) =>
            found === undefined ? Effect.fail(error) : Effect.succeed(found),
          ),
        ),
      ),
    getConnection: (id) =>
      send("getAuthConnection", HttpClientRequest.get(connectionPath(id))).pipe(
        Effect.flatMap(decoded("getAuthConnection", AuthConnection)),
        Effect.catchIf(status(404), () => Effect.succeed(null)),
      ),
    stopSavingCredentials: (id) =>
      send(
        "updateAuthConnection",
        HttpClientRequest.make("PATCH")(connectionPath(id)).pipe(
          HttpClientRequest.bodyJsonUnsafe({ save_credentials: false }),
        ),
      ).pipe(Effect.asVoid),
    login: (id) =>
      send(
        "startAuthLogin",
        HttpClientRequest.post(connectionPath(id, "/login")).pipe(
          HttpClientRequest.bodyJsonUnsafe({ record_session: false }),
        ),
      ).pipe(
        Effect.asVoid,
        Effect.catchIf(status(409), () => Effect.void),
      ),
    submit: (id, answer) =>
      send(
        "submitAuthInput",
        HttpClientRequest.post(connectionPath(id, "/submit")).pipe(
          HttpClientRequest.bodyJsonUnsafe(answer),
        ),
      ).pipe(Effect.asVoid),
  };
};
