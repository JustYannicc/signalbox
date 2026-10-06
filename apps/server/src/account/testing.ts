import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AccountAuthorizeParams } from "@t3tools/contracts/account";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { HttpServerRequest } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as AccountFlow from "@signalbox/account/AccountFlow";
import {
  WORKOS_TEST_ENV,
  type WorkOSCodes,
  workosStubLayer,
} from "@signalbox/account/WorkOSTesting";
import * as AccountService from "./AccountService.ts";

/** Test wiring for the account module: in-memory SQLite, real EnvironmentAuth, fake WorkOS. */

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-account-test-" });

export const environmentAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
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
