import * as AccountConfig from "@signalbox/account/AccountConfig";
import { EnvironmentId } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

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
 */

const MIN_SECRET_LENGTH = 32;

export class CloudConfig extends Context.Service<
  CloudConfig,
  {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly sessionSecret: Redacted.Redacted<string>;
    readonly accounts: AccountConfig.AccountConfig;
    readonly workosWebhookSecret: Redacted.Redacted<string> | undefined;
  }
>()("@signalbox/cloud/CloudConfig") {}

const make = Effect.gen(function* () {
  const environmentId = yield* Config.schema(EnvironmentId, "ENVIRONMENT_ID");
  const label = yield* Config.String("ENVIRONMENT_LABEL").pipe(
    Config.withDefault(DEFAULT_ENVIRONMENT_LABEL),
  );
  const sessionSecret = yield* Config.Redacted("SESSION_SECRET");
  if (Redacted.value(sessionSecret).length < MIN_SECRET_LENGTH) {
    return yield* Effect.die(
      new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`),
    );
  }
  const accounts = yield* AccountConfig.read;
  if (!accounts) {
    return yield* Effect.die(new Error("T3CODE_WORKOS_CLIENT_ID is required for the cloud"));
  }
  const workosWebhookSecret = yield* Config.Redacted("T3CODE_WORKOS_WEBHOOK_SECRET").pipe(
    Config.option,
  );
  return CloudConfig.of({
    environmentId,
    label,
    sessionSecret,
    accounts,
    // Deploys pass an unset secret as empty; an empty key would sign anything.
    workosWebhookSecret: Option.getOrUndefined(
      Option.filter(workosWebhookSecret, (secret) => Redacted.value(secret).length > 0),
    ),
  });
});

/** Reads the ambient `ConfigProvider`; the Worker builds one from its `env`. */
export const layer = Layer.effect(CloudConfig, make);
