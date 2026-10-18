import * as AccountConfig from "@signalbox/account/AccountConfig";
import { EnvironmentId } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { searchSettings } from "./search/searchSettings.ts";
import { DEFAULT_ENVIRONMENT_LABEL } from "./environment.ts";

/**
 * Deployment settings, read from Worker vars and secrets:
 * - `ENVIRONMENT_ID`: this cloud's environment id. Stable for the life of the
 *   deployment; clients key saved connections and caches on it.
 * - `ENVIRONMENT_LABEL`: optional display name.
 * - `SESSION_SECRET`: signs session tokens and seals sign-in state. Rotating
 *   it signs everyone out.
 * - `T3CODE_WORKOS_*`: the same account settings as a self-hosted server (see
 *   `@signalbox/account/AccountConfig`). The cloud refuses to start without a
 *   client id, because signing in is the only way in.
 * - `T3CODE_WORKOS_WEBHOOK_SECRET`: optional; signs WorkOS's webhook events,
 *   which tell the cloud at once when someone joins or leaves an
 *   organization. Without it, memberships refresh only when people sign in.
 * - `SCRIPTED_PROVIDER`: `1` offers the scripted provider, a stand-in that
 *   echoes instead of running a model. Dev and tests only; production leaves
 *   it unset. The user and thread objects read it from the same vars
 *   (`thread/scriptedProvider.ts`); the Worker itself never offers providers.
 */

const MIN_SECRET_LENGTH = 32;

/** A secret that may be unset. Deploys pass an unset secret as empty, which counts as unset. */
export const optionalSecret = (name: string) =>
  Config.Redacted(name).pipe(
    Config.option,
    Config.map(Option.filter((value) => Redacted.value(value).trim().length > 0)),
  );

/** A plain var that may be unset. Deploys pass an unset var as empty, which counts as unset. */
export const optionalString = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map(Option.map((value) => value.trim())),
    Config.map(Option.filter((value) => value.length > 0)),
  );

export class CloudConfig extends Context.Service<
  CloudConfig,
  {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly searchDisabled?: boolean;
    readonly sessionSecret: Redacted.Redacted<string>;
    readonly accounts: AccountConfig.AccountConfig;
    readonly workosWebhookSecret: Redacted.Redacted<string> | undefined;
    readonly drives?: boolean;
  }
>()("@signalbox/cloud/CloudConfig") {}

/**
 * `SESSION_SECRET` on its own, for user objects, which sign with it
 * (`CloudTokens.layerSessionSecret`) but have no use for the rest.
 */
export const readSessionSecret = Effect.gen(function* () {
  const sessionSecret = yield* Config.Redacted("SESSION_SECRET");
  if (Redacted.value(sessionSecret).length < MIN_SECRET_LENGTH) {
    return yield* Effect.die(
      new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`),
    );
  }
  return sessionSecret;
});

const make = Effect.gen(function* () {
  const environmentId = yield* Config.schema(EnvironmentId, "ENVIRONMENT_ID");
  const label = yield* Config.String("ENVIRONMENT_LABEL").pipe(
    Config.withDefault(DEFAULT_ENVIRONMENT_LABEL),
  );
  const sessionSecret = yield* readSessionSecret;
  const accounts = yield* AccountConfig.read;
  if (!accounts) {
    return yield* Effect.die(new Error("T3CODE_WORKOS_CLIENT_ID is required for the cloud"));
  }
  const workosWebhookSecret = yield* optionalSecret("T3CODE_WORKOS_WEBHOOK_SECRET");
  const search = searchSettings({
    SEARCH_INDEX_GENERATION: yield* Config.String("SEARCH_INDEX_GENERATION").pipe(
      Config.withDefault("1"),
    ),
    SEARCH_INDEX_DISABLED: yield* Config.String("SEARCH_INDEX_DISABLED").pipe(
      Config.withDefault("0"),
    ),
  });
  return CloudConfig.of({
    searchDisabled: search.disabled,
    environmentId,
    label,
    sessionSecret,
    accounts,
    // An empty key would sign anything.
    workosWebhookSecret: Option.getOrUndefined(workosWebhookSecret),
  });
});

/** Reads the ambient `ConfigProvider`; the Worker builds one from its `env`. */
export const layer = Layer.effect(CloudConfig, make);

export const layerWithDrives = (drives: boolean) =>
  Layer.effect(
    CloudConfig,
    Effect.map(make, (config) => ({ ...config, drives })),
  );
