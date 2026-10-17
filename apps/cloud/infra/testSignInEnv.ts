import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/** Production never reads or forwards test credentials, even if CI supplies them. */
export const testSignInEnv = (production: boolean) =>
  production
    ? Effect.succeed({})
    : Config.all({
        E2E_SIGN_IN_SECRET: Config.Redacted("E2E_SIGN_IN_SECRET").pipe(
          Config.withDefault(Redacted.make("")),
        ),
        E2E_WORKOS_CLIENT_ID: Config.String("E2E_WORKOS_CLIENT_ID").pipe(Config.withDefault("")),
        E2E_WORKOS_API_KEY: Config.Redacted("E2E_WORKOS_API_KEY").pipe(
          Config.withDefault(Redacted.make("")),
        ),
      });
