import {
  ACCOUNT_HANDOFF_PATH,
  ACCOUNT_SESSION_PATH,
  ACCOUNT_SIGN_OUT_PATH,
  ACCOUNT_VERIFY_EMAIL_PATH,
  AccountHandoffFailure,
  AccountHandoffResult,
  AccountSessionState,
  AccountSignInError,
  AccountVerifyEmailFailure,
  AccountVerifyEmailResult,
  type AccountHandoffResult as AccountHandoffResultType,
  type AccountSessionState as AccountSessionStateType,
  type AccountVerifyEmailFailure as AccountVerifyEmailFailureType,
  type AccountVerifyEmailResult as AccountVerifyEmailResultType,
  type AccountHandoffRequest,
} from "@t3tools/contracts/account";
import {
  GITHUB_CONNECT_PATH,
  GitHubNativeConnectResponse,
} from "@t3tools/contracts/signalboxGitHubConnect";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as HttpHeaders from "effect/http/Headers";

import {
  AccountHandoffError,
  AccountHttpStatusError,
  AccountRequestFailedError,
  AccountRequestTimeoutError,
  AccountResponseDecodeError,
  DEFAULT_ACCOUNT_REQUEST_TIMEOUT_MS,
  isAccountHandoffError,
  isAccountHttpStatusError,
  isAccountRequestFailedError,
  isAccountRequestTimeoutError,
  isAccountResponseDecodeError,
  type AccountClientError,
  type AccountOperation,
} from "./errors.ts";

export interface AccountSessionInput {
  readonly origin: string;
  readonly headers?: HeadersInit;
  readonly credentials?: RequestCredentials;
  readonly timeoutMs?: number;
}

export interface AccountSessionRequestInput {
  readonly origin: string;
  readonly credentials?: RequestCredentials;
  readonly timeoutMs?: number;
}

export interface AccountSignOutInput extends AccountSessionRequestInput {
  readonly headers?: HeadersInit;
}

export type AccountVerifyEmailResponse =
  | {
      readonly ok: true;
      readonly body: AccountVerifyEmailResultType;
    }
  | {
      readonly ok: false;
      readonly body: AccountVerifyEmailFailureType;
    };

export class AccountClient extends Context.Service<
  AccountClient,
  {
    readonly fetchSession: (
      input: AccountSessionInput,
    ) => Effect.Effect<AccountSessionStateType, AccountClientError>;
    readonly redeemHandoff: (input: {
      readonly origin: string;
      readonly request: AccountHandoffRequest;
      readonly timeoutMs?: number;
    }) => Effect.Effect<AccountHandoffResultType, AccountClientError>;
    readonly startGitHubNativeConnect: (input: {
      readonly origin: string;
      readonly token: string;
      readonly returnUrl: string;
      readonly timeoutMs?: number;
    }) => Effect.Effect<string, AccountClientError>;
    readonly signOut: (input: AccountSignOutInput) => Effect.Effect<void, AccountClientError>;
    readonly verifyEmailCode: (input: {
      readonly origin: string;
      readonly request: { readonly verify: string; readonly code: string };
      readonly timeoutMs?: number;
    }) => Effect.Effect<AccountVerifyEmailResponse, AccountClientError>;
  }
>()("@t3tools/client-runtime/account/client/AccountClient") {}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function toHttpHeaders(headers?: HeadersInit): HttpHeaders.Input | undefined {
  if (headers === undefined) return undefined;
  if (Array.isArray(headers)) return headers as Iterable<readonly [string, string]>;
  if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.entries();
  return headers as Readonly<Record<string, string>>;
}

function withHeaders(
  request: HttpClientRequest.HttpClientRequest,
  headers?: HeadersInit,
): HttpClientRequest.HttpClientRequest {
  const input = toHttpHeaders(headers);
  return input === undefined ? request : HttpClientRequest.setHeaders(request, input);
}

function decodeResponse<S extends Schema.ConstraintDecoder<unknown>>(
  response: HttpClientResponse.HttpClientResponse,
  schema: S,
  operation: AccountOperation,
): Effect.Effect<S["Type"], AccountResponseDecodeError, S["DecodingServices"]> {
  return response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((cause) => new AccountResponseDecodeError({ operation, cause })),
  );
}

function isOk(response: HttpClientResponse.HttpClientResponse): boolean {
  return response.status >= 200 && response.status < 300;
}

function isAccountClientError(error: unknown): error is AccountClientError {
  return (
    isAccountRequestFailedError(error) ||
    isAccountRequestTimeoutError(error) ||
    isAccountHttpStatusError(error) ||
    isAccountResponseDecodeError(error) ||
    isAccountHandoffError(error)
  );
}

function runRequest<A, E>(
  operation: AccountOperation,
  input: {
    readonly timeoutMs?: number | undefined;
    readonly credentials?: RequestCredentials | undefined;
  },
  request: Effect.Effect<A, E>,
): Effect.Effect<A, AccountClientError> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_ACCOUNT_REQUEST_TIMEOUT_MS;
  return request.pipe(
    Effect.provideService(
      FetchHttpClient.RequestInit,
      input.credentials === undefined ? {} : { credentials: input.credentials },
    ),
    // Account hosts may be cross-origin and don't promise tracing headers in CORS.
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.timeout(timeoutMs),
    Effect.mapError((cause) => {
      if (Cause.isTimeoutError(cause)) {
        return new AccountRequestTimeoutError({ operation, timeoutMs });
      }
      return isAccountClientError(cause)
        ? cause
        : new AccountRequestFailedError({ operation, cause });
    }),
  );
}

const isSignInError = Schema.is(AccountSignInError);
const isHandoffFailure = Schema.is(AccountHandoffFailure);

export const layer: Layer.Layer<AccountClient, never, HttpClient.HttpClient> = Layer.effect(
  AccountClient,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;

    const fetchSession: AccountClient["Service"]["fetchSession"] = (input) => {
      const request = Effect.gen(function* () {
        const response = yield* httpClient.get(
          `${trimTrailingSlash(input.origin)}${ACCOUNT_SESSION_PATH}`,
          input.headers === undefined ? undefined : { headers: toHttpHeaders(input.headers) },
        );
        if (!isOk(response)) {
          return yield* new AccountHttpStatusError({
            operation: "session",
            status: response.status,
          });
        }
        return yield* decodeResponse(response, AccountSessionState, "session");
      });
      return runRequest(
        "session",
        { timeoutMs: input.timeoutMs, credentials: input.credentials ?? "include" },
        request,
      );
    };

    const redeemHandoff: AccountClient["Service"]["redeemHandoff"] = (input) => {
      const request = HttpClientRequest.post(
        `${trimTrailingSlash(input.origin)}${ACCOUNT_HANDOFF_PATH}`,
      ).pipe(
        HttpClientRequest.setHeader("content-type", "application/json"),
        HttpClientRequest.bodyJsonUnsafe(input.request),
      );
      const response = Effect.gen(function* () {
        const result = yield* httpClient.execute(request);
        if (result.status === 404) {
          return yield* new AccountHandoffError({ code: "expired" });
        }
        if (isOk(result)) return yield* decodeResponse(result, AccountHandoffResult, "handoff");
        const body = yield* result.json.pipe(Effect.orElseSucceed(() => null));
        return yield* new AccountHandoffError({
          code: isHandoffFailure(body) && isSignInError(body.error) ? body.error : "failed",
        });
      });
      return runRequest("handoff", { timeoutMs: input.timeoutMs, credentials: "omit" }, response);
    };

    const startGitHubNativeConnect: AccountClient["Service"]["startGitHubNativeConnect"] = (
      input,
    ) => {
      const request = HttpClientRequest.post(
        `${trimTrailingSlash(input.origin)}${GITHUB_CONNECT_PATH}`,
      ).pipe(
        HttpClientRequest.setHeaders({ authorization: `Bearer ${input.token}` }),
        HttpClientRequest.bodyJsonUnsafe({ returnUrl: input.returnUrl }),
      );
      const response = Effect.gen(function* () {
        const result = yield* httpClient.execute(request);
        if (!isOk(result)) {
          return yield* new AccountHttpStatusError({
            operation: "github-connect",
            status: result.status,
          });
        }
        const connect = yield* decodeResponse(
          result,
          GitHubNativeConnectResponse,
          "github-connect",
        );
        return connect.url;
      });
      return runRequest(
        "github-connect",
        { timeoutMs: input.timeoutMs, credentials: "omit" },
        response,
      );
    };

    const signOut: AccountClient["Service"]["signOut"] = (input) => {
      const request = withHeaders(
        HttpClientRequest.post(`${trimTrailingSlash(input.origin)}${ACCOUNT_SIGN_OUT_PATH}`),
        input.headers,
      );
      const response = Effect.gen(function* () {
        const result = yield* httpClient.execute(request);
        if (!isOk(result)) {
          return yield* new AccountHttpStatusError({
            operation: "sign-out",
            status: result.status,
          });
        }
      });
      return runRequest(
        "sign-out",
        { timeoutMs: input.timeoutMs, credentials: input.credentials },
        response,
      );
    };

    const verifyEmailCode: AccountClient["Service"]["verifyEmailCode"] = (input) => {
      const request = HttpClientRequest.post(
        `${trimTrailingSlash(input.origin)}${ACCOUNT_VERIFY_EMAIL_PATH}`,
      ).pipe(HttpClientRequest.bodyJsonUnsafe(input.request));
      const response = Effect.gen(function* () {
        const result = yield* httpClient.execute(request);
        if (isOk(result)) {
          const body = yield* decodeResponse(result, AccountVerifyEmailResult, "verify-email");
          return { ok: true, body } as const;
        }
        const body = yield* decodeResponse(result, AccountVerifyEmailFailure, "verify-email");
        return { ok: false, body } as const;
      });
      return runRequest(
        "verify-email",
        { timeoutMs: input.timeoutMs, credentials: "include" },
        response,
      );
    };

    return AccountClient.of({
      fetchSession,
      redeemHandoff,
      startGitHubNativeConnect,
      signOut,
      verifyEmailCode,
    });
  }),
);

export const useAccountClient = <A, E>(
  use: (client: AccountClient["Service"]) => Effect.Effect<A, E>,
): Effect.Effect<A, E, AccountClient> =>
  Effect.gen(function* () {
    const client = yield* AccountClient;
    return yield* use(client);
  });
