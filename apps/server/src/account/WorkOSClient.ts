import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

/**
 * The one WorkOS endpoint the server calls: exchanging an authorization code
 * (or, when WorkOS asks for it, an email verification code) for the user.
 * WorkOS tokens in the response are ignored; the server issues its own
 * environment session.
 *
 * Never log the request or the raw response: they carry the code, the PKCE
 * verifier, the client secret, and WorkOS tokens.
 */

export interface WorkOSConfig {
  readonly clientId: string;
  readonly apiKey?: Redacted.Redacted<string>;
  readonly apiBaseUrl: string;
}

const WorkOSUserBody = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  first_name: Schema.optional(Schema.NullOr(Schema.String)),
  last_name: Schema.optional(Schema.NullOr(Schema.String)),
  profile_picture_url: Schema.optional(Schema.NullOr(Schema.String)),
});

const AuthenticateResponse = Schema.Struct({ user: WorkOSUserBody });
/**
 * WorkOS uses two error shapes: `{ error, error_description }` (OAuth) and
 * `{ code, message, pending_authentication_token, ... }` (AuthKit flows).
 */
const AuthenticateErrorBody = Schema.Struct({
  error: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  pending_authentication_token: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
});

export interface WorkOSUser {
  readonly id: string;
  readonly email: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly avatarUrl?: string;
}

export class WorkOSAuthenticateError extends Schema.TaggedError<WorkOSAuthenticateError>()(
  "WorkOSAuthenticateError",
  {
    /** HTTP status, absent when the request never got a response. */
    status: Schema.optional(Schema.Number),
    /** WorkOS's OAuth `error` (e.g. `invalid_grant`). Safe to log. */
    error: Schema.optional(Schema.String),
    /** WorkOS's AuthKit `code` (e.g. `mfa_enrollment`). Safe to log. */
    code: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const detail = [this.status ?? "no response", this.error, this.code].filter(Boolean);
    return `WorkOS authentication failed (${detail.join(", ")}).`;
  }
}

/**
 * WorkOS wants the user to prove their email (it trusts Google's emails, not
 * GitHub's) and has sent them a code. The token finishes the sign-in.
 */
export class WorkOSEmailVerificationRequired extends Schema.TaggedError<WorkOSEmailVerificationRequired>()(
  "WorkOSEmailVerificationRequired",
  {
    pendingToken: Schema.Redacted(Schema.String),
    email: Schema.String,
  },
) {
  override get message(): string {
    return "WorkOS requires email verification before sign-in.";
  }
}

export type WorkOSGrant =
  | { readonly kind: "authorization-code"; readonly code: string; readonly codeVerifier: string }
  | {
      readonly kind: "email-verification";
      readonly code: string;
      readonly pendingToken: Redacted.Redacted<string>;
    };

const grantBody = (grant: WorkOSGrant) =>
  grant.kind === "authorization-code"
    ? {
        grant_type: "authorization_code",
        code: grant.code,
        code_verifier: grant.codeVerifier,
      }
    : {
        grant_type: "urn:workos:oauth:grant-type:email-verification:code",
        code: grant.code,
        pending_authentication_token: Redacted.value(grant.pendingToken),
      };

const nonEmpty = (value: string | null | undefined) =>
  value === null || value === undefined || value.length === 0 ? undefined : value;

/** `POST /user_management/authenticate` for either grant. */
export const authenticate = Effect.fn("WorkOS.authenticate")(function* (
  config: WorkOSConfig,
  grant: WorkOSGrant,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const request = yield* HttpClientRequest.post(
    new URL("/user_management/authenticate", config.apiBaseUrl),
  ).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bodyJson({
      client_id: config.clientId,
      ...(config.apiKey ? { client_secret: Redacted.value(config.apiKey) } : {}),
      ...grantBody(grant),
    }),
    Effect.mapError(() => new WorkOSAuthenticateError({})),
  );
  const response = yield* httpClient
    .execute(request)
    .pipe(Effect.mapError(() => new WorkOSAuthenticateError({})));

  if (response.status < 200 || response.status >= 300) {
    const body = yield* HttpClientResponse.schemaBodyJson(AuthenticateErrorBody)(response).pipe(
      Effect.orElseSucceed(() => ({}) as typeof AuthenticateErrorBody.Type),
    );
    if (
      body.code === "email_verification_required" &&
      body.pending_authentication_token &&
      body.email
    ) {
      return yield* new WorkOSEmailVerificationRequired({
        pendingToken: Redacted.make(body.pending_authentication_token),
        email: body.email,
      });
    }
    return yield* new WorkOSAuthenticateError({
      status: response.status,
      ...(body.error ? { error: body.error } : {}),
      ...(body.code ? { code: body.code } : {}),
    });
  }

  const { user } = yield* HttpClientResponse.schemaBodyJson(AuthenticateResponse)(response).pipe(
    Effect.mapError(
      () => new WorkOSAuthenticateError({ status: response.status, error: "invalid_response" }),
    ),
  );
  const firstName = nonEmpty(user.first_name);
  const lastName = nonEmpty(user.last_name);
  const avatarUrl = nonEmpty(user.profile_picture_url);
  return {
    id: user.id,
    email: user.email,
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  } satisfies WorkOSUser;
});
