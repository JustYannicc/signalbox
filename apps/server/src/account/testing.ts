import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AccountAuthorizeParams } from "@t3tools/contracts/account";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse, type HttpServerRequest } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as AccountFlow from "./AccountFlow.ts";
import * as AccountService from "./AccountService.ts";

/** Test wiring for the account module: in-memory SQLite, real EnvironmentAuth, fake WorkOS. */

export const WORKOS_TEST_ENV = {
  T3CODE_WORKOS_CLIENT_ID: "client_test",
  T3CODE_WORKOS_API_BASE_URL: "https://workos.test",
} as const;

export interface WorkOSTestUser {
  readonly id: string;
  readonly email: string;
  readonly first_name?: string | null;
  readonly last_name?: string | null;
  readonly profile_picture_url?: string | null;
}

/**
 * Authorization codes WorkOS will accept. A plain user signs straight in; a
 * `verify` entry makes WorkOS demand email verification with that code
 * (GitHub-style), and `{ fail }` answers with that AuthKit error code.
 */
export type WorkOSCodes = Readonly<
  Record<
    string,
    | WorkOSTestUser
    | { readonly verify: { readonly code: string; readonly user: WorkOSTestUser } }
    | { readonly fail: string }
  >
>;

export const EMAIL_VERIFICATION_GRANT = "urn:workos:oauth:grant-type:email-verification:code";

const decodeBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** Fake `POST /user_management/authenticate`. Records each request body. */
export const workosStubLayer = (
  codes: WorkOSCodes,
  exchanges: Array<Record<string, unknown>> = [],
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body =
          request.body._tag === "Uint8Array"
            ? decodeBody(new TextDecoder().decode(request.body.body))
            : {};
        exchanges.push({ url: request.url, ...body });
        const signedIn = (user: WorkOSTestUser) =>
          Response.json({ user, access_token: "workos-access", refresh_token: "workos-refresh" });
        const respond = (): Response => {
          if (body.grant_type === EMAIL_VERIFICATION_GRANT) {
            const entry = Object.entries(codes).find(
              ([authCode]) => `pending-${authCode}` === body.pending_authentication_token,
            )?.[1];
            if (!entry || !("verify" in entry)) {
              return Response.json(
                { code: "invalid_pending_authentication_token" },
                { status: 400 },
              );
            }
            return body.code === entry.verify.code
              ? signedIn(entry.verify.user)
              : Response.json({ code: "email_verification_code_invalid" }, { status: 400 });
          }
          const entry = typeof body.code === "string" ? codes[body.code] : undefined;
          if (!entry) return Response.json({ error: "invalid_grant" }, { status: 400 });
          if ("fail" in entry) {
            return Response.json(
              { code: entry.fail, message: "nope", pending_authentication_token: "secret" },
              { status: 403 },
            );
          }
          if ("verify" in entry) {
            return Response.json(
              {
                code: "email_verification_required",
                message: "Email ownership must be verified before authentication.",
                pending_authentication_token: `pending-${String(body.code)}`,
                email: entry.verify.user.email,
                email_verification_id: "email_verification_1",
              },
              { status: 403 },
            );
          }
          return signedIn(entry);
        };
        return HttpClientResponse.fromWeb(request, respond());
      }),
    ),
  );

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-account-test-" });

export const environmentAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(serverConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

/** AccountService plus everything it uses, exposed for assertions. */
export const accountTestLayer = (options: {
  readonly codes?: WorkOSCodes;
  readonly exchanges?: Array<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, string>>;
}) =>
  AccountService.layer.pipe(
    Layer.provide(workosStubLayer(options.codes ?? {}, options.exchanges)),
    Layer.provide(
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: options.env ?? WORKOS_TEST_ENV })),
    ),
    Layer.provideMerge(environmentAuthLayer),
  );

export const VERIFIER = "native-client-verifier-0123456789abcdefghijklmnop";
export const CODES: WorkOSCodes = {
  "code-owner": { id: "user_owner", email: "owner@example.com", first_name: "Ada" },
  "code-owner-renamed": { id: "user_owner", email: "owner@example.com", first_name: "Ada L." },
  "code-other": { id: "user_other", email: "other@example.com" },
  "code-github": {
    verify: { code: "123456", user: { id: "user_github", email: "gh@example.com" } },
  },
  "code-mfa": { fail: "mfa_enrollment" },
};

export const browserParams: AccountAuthorizeParams = {
  provider: "google",
  origin: "https://box.example.com",
  mode: "browser",
  returnTo: "/threads",
};
export const nativeParams: AccountAuthorizeParams = {
  provider: "email",
  origin: "https://box.example.com",
  mode: "native",
  returnUrl: "signalbox://auth/return",
  challenge: AccountFlow.pkceChallenge(VERIFIER),
};

type Request = HttpServerRequest.HttpServerRequest;
export const anonymousRequest = { cookies: {}, headers: {} } as unknown as Request;
export const cookieRequest = (name: string, token: string) =>
  ({ cookies: { [name]: token }, headers: {} }) as unknown as Request;
export const bearerRequest = (token: string) =>
  ({ cookies: {}, headers: { authorization: `Bearer ${token}` } }) as unknown as Request;

/** authorize → WorkOS (skipped) → callback, as the browser would drive it. */
export const signIn = Effect.fn(function* (
  params: AccountAuthorizeParams,
  code: string,
  request: Request = anonymousRequest,
) {
  const accounts = yield* AccountService.AccountService;
  const authorizeUrl = new URL(yield* accounts.authorize(params));
  const state = authorizeUrl.searchParams.get("state") ?? "";
  return yield* accounts.callback({ state, code }, request);
});

export const runAccountTest = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof accountTestLayer>>>,
  options: Parameters<typeof accountTestLayer>[0] = { codes: CODES },
) => effect.pipe(Effect.provide(accountTestLayer(options)));
