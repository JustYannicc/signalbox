import {
  PERSON_TIMEZONE_WS_METHODS as methods,
  PersonTimezoneError,
} from "@t3tools/contracts/personTimezone";
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";

import * as UserTimezone from "./UserTimezone.ts";

export const makeTimezoneHandlers = Effect.gen(function* () {
  const timezone = yield* UserTimezone.UserTimezone;
  const call = <A>(
    operation: PersonTimezoneError["operation"],
    effect: Effect.Effect<A, SqlError>,
  ) =>
    effect.pipe(
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.logError("cloud timezone storage failed", { cause }).pipe(
            Effect.andThen(
              Effect.fail(
                new PersonTimezoneError({
                  operation,
                  cause,
                  message:
                    operation === "read"
                      ? "Couldn't read your timezone. Try again."
                      : "Couldn't save your timezone. Try again.",
                }),
              ),
            ),
          ),
      }),
    );
  return {
    [methods.get]: () => call("read", timezone.settings),
    [methods.set]: (input: { readonly timezone: string | null }) =>
      call("set", timezone.set(input.timezone)),
    [methods.report]: (input: { readonly timezone: string }) =>
      call("report", timezone.report(input.timezone)),
  };
});
