import type { WorkOSConfig } from "@signalbox/account/WorkOSClient";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as CloudConfig from "../CloudConfig.ts";
import { E2E_USER_ID_HASHES } from "./TestIdentityRegistry.ts";
import { trustedEnvironment } from "./testEnvironment.ts";

const encoder = new TextEncoder();

export class IdentityProviderUnavailable extends Schema.TaggedError<IdentityProviderUnavailable>()(
  "IdentityProviderUnavailable",
  {},
) {
  override get message() {
    return "The identity provider is unavailable.";
  }
}

export class IdentityProviders extends Context.Service<
  IdentityProviders,
  {
    readonly identityProviderForUser: (
      userId: string,
    ) => Effect.Effect<WorkOSConfig, IdentityProviderUnavailable>;
  }
>()("@signalbox/cloud/account/IdentityProvider/IdentityProviders") {}

interface ResolverConfig {
  readonly primary: WorkOSConfig;
  readonly e2e: WorkOSConfig | undefined;
  readonly enabled: boolean;
  readonly knownHashes: ReadonlySet<string>;
}

const hashUserId = (userId: string) =>
  Effect.tryPromise({
    try: async () => {
      const digest = new Uint8Array(
        await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(userId)),
      );
      return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    },
    catch: () => new IdentityProviderUnavailable({}),
  });

type SafeE2EConfig = WorkOSConfig & { readonly apiKey: Redacted.Redacted<string> };

const isSafeE2EConfig = (
  primary: WorkOSConfig,
  e2e: WorkOSConfig | undefined,
): e2e is SafeE2EConfig =>
  e2e !== undefined &&
  e2e.apiKey !== undefined &&
  Redacted.value(e2e.apiKey).startsWith("sk_test_") &&
  e2e.clientId !== primary.clientId &&
  (primary.apiKey === undefined || Redacted.value(e2e.apiKey) !== Redacted.value(primary.apiKey));

export const makeIdentityProviderResolver = ({
  primary,
  e2e,
  enabled,
  knownHashes,
}: ResolverConfig): IdentityProviders["Service"] => ({
  identityProviderForUser: (userId) =>
    hashUserId(userId).pipe(
      Effect.flatMap((hash) =>
        !knownHashes.has(hash)
          ? Effect.succeed(primary)
          : enabled && isSafeE2EConfig(primary, e2e)
            ? Effect.succeed(e2e)
            : Effect.fail(new IdentityProviderUnavailable({})),
      ),
    ),
});

const make = Effect.gen(function* () {
  const cloud = yield* CloudConfig.CloudConfig;
  const config = yield* Config.all({
    stage: Config.String("SIGNALBOX_STAGE").pipe(Config.option),
    localWorkerd: Config.String("LOCAL_WORKERD").pipe(Config.option),
    signInSecret: Config.Redacted("E2E_SIGN_IN_SECRET").pipe(Config.option),
    e2eClientId: Config.String("E2E_WORKOS_CLIENT_ID").pipe(Config.option),
    e2eApiKey: Config.Redacted("E2E_WORKOS_API_KEY").pipe(Config.option),
  });

  const stage = Option.getOrUndefined(config.stage);
  const localWorkerd = Option.getOrUndefined(config.localWorkerd);
  const signInSecret = Option.getOrUndefined(config.signInSecret);
  const e2eClientId = Option.getOrUndefined(config.e2eClientId)?.trim();
  const e2eApiKey = Option.getOrUndefined(config.e2eApiKey);
  const primary = cloud.accounts.workos;
  const e2e: WorkOSConfig | undefined =
    e2eClientId && e2eApiKey
      ? {
          clientId: e2eClientId,
          apiKey: e2eApiKey,
          apiBaseUrl: "https://api.workos.com",
        }
      : undefined;
  const trusted = trustedEnvironment(stage, cloud.environmentId, localWorkerd) !== undefined;
  const enabled =
    trusted && signInSecret !== undefined && Redacted.value(signInSecret).length >= 32;

  return IdentityProviders.of(
    makeIdentityProviderResolver({
      primary,
      e2e,
      enabled,
      knownHashes: E2E_USER_ID_HASHES,
    }),
  );
});

export const layer = Layer.effect(IdentityProviders, make);
