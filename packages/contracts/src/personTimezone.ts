import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";

export const PersonTimezone = Schema.String.check(
  Schema.makeFilter(
    (zone) => {
      if (zone.length > 128 || !/^[A-Za-z]/.test(zone)) return false;
      try {
        Intl.DateTimeFormat("en", { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    },
    { message: "Choose a valid IANA timezone, such as Europe/Zurich." },
  ),
).annotate({ description: "IANA timezone, such as Europe/Zurich or UTC." });

export const PersonTimezoneSettings = Schema.Struct({
  timezone: PersonTimezone,
  source: Schema.Literals(["device", "manual"]),
  deviceTimezone: Schema.NullOr(PersonTimezone),
});
export type PersonTimezoneSettings = typeof PersonTimezoneSettings.Type;

export class PersonTimezoneError extends Schema.TaggedError<PersonTimezoneError>()(
  "PersonTimezoneError",
  { message: Schema.String },
) {}

export const PERSON_TIMEZONE_WS_METHODS = {
  get: "signalbox.timezone.get",
  set: "signalbox.timezone.set",
  report: "signalbox.timezone.report",
} as const;

export const PERSON_TIMEZONE_REQUIRED_SCOPES = {
  [PERSON_TIMEZONE_WS_METHODS.get]: AuthOrchestrationReadScope,
  [PERSON_TIMEZONE_WS_METHODS.set]: AuthSettingsWriteScope,
  [PERSON_TIMEZONE_WS_METHODS.report]: AuthSettingsWriteScope,
} as const;

const error = Schema.Union([PersonTimezoneError, EnvironmentAuthorizationError]);

export const PERSON_TIMEZONE_RPCS = [
  Rpc.make(PERSON_TIMEZONE_WS_METHODS.get, {
    payload: Schema.Struct({}),
    success: PersonTimezoneSettings,
    error,
  }),
  Rpc.make(PERSON_TIMEZONE_WS_METHODS.set, {
    payload: Schema.Struct({ timezone: Schema.NullOr(PersonTimezone) }),
    success: PersonTimezoneSettings,
    error,
  }),
  Rpc.make(PERSON_TIMEZONE_WS_METHODS.report, {
    payload: Schema.Struct({ timezone: PersonTimezone }),
    success: PersonTimezoneSettings,
    error,
  }),
] as const;
