import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { importPKCS8, SignJWT } from "jose";

import * as CloudConfig from "../../CloudConfig.ts";

export interface ApnsKey {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: Redacted.Redacted<string>;
}

const ServiceAccount = Schema.fromJsonString(
  Schema.Struct({
    project_id: Schema.NonEmptyString,
    client_email: Schema.NonEmptyString,
    private_key: Schema.NonEmptyString,
  }),
);
export type ServiceAccount = typeof ServiceAccount.Type;
const decodeServiceAccount = Schema.decodeUnknownEffect(ServiceAccount);
/** The push credentials this deployment has. */
export const readCredentials = Effect.gen(function* () {
  const teamId = yield* CloudConfig.optionalSecret("APNS_TEAM_ID");
  const keyId = yield* CloudConfig.optionalSecret("APNS_KEY_ID");
  const privateKey = yield* CloudConfig.optionalSecret("APNS_PRIVATE_KEY");
  const fcmJson = yield* CloudConfig.optionalSecret("FCM_SERVICE_ACCOUNT");
  const fcm = Option.isNone(fcmJson)
    ? null
    : yield* decodeServiceAccount(Redacted.value(fcmJson.value)).pipe(
        Effect.tapError((cause) => Effect.logError("FCM_SERVICE_ACCOUNT unreadable", { cause })),
        Effect.orElseSucceed(() => null),
      );
  const apns: ApnsKey | null =
    Option.isSome(teamId) && Option.isSome(keyId) && Option.isSome(privateKey)
      ? {
          teamId: Redacted.value(teamId.value).trim(),
          keyId: Redacted.value(keyId.value).trim(),
          privateKey: privateKey.value,
        }
      : null;
  return { apns, fcm };
}).pipe(
  // A malformed value silences pushes, never the user's object.
  Effect.catch((cause) =>
    Effect.as(Effect.logError("push credentials unreadable", { cause }), {
      apns: null,
      fcm: null,
    }),
  ),
);

/** A JWT signed with a PKCS#8 PEM key; tolerates keys pasted with literal `\n`. */
export const signJwt = (
  alg: "ES256" | "RS256",
  privateKey: string,
  header: Record<string, string>,
  claims: Record<string, string | number>,
) =>
  Effect.tryPromise(async () =>
    new SignJWT(claims)
      .setProtectedHeader({ alg, ...header })
      .sign(await importPKCS8(privateKey.replace(/\\n/g, "\n").trim(), alg)),
  );
