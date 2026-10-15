import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { importPKCS8, SignJWT } from "jose";

import * as CloudConfig from "../CloudConfig.ts";
import type { PushDevice } from "./PushDevices.ts";
import type { PushMessage } from "./pushRules.ts";

/**
 * Sends one push to one phone, straight to Apple (APNs) or Google (FCM), the
 * same native tokens and payload shape the T3 Connect relay uses, so the app
 * routes a tap the same way. Credentials are Worker secrets:
 *
 * - `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`: an APNs auth key (`.p8`)
 *   of the team that signs the app.
 * - `FCM_SERVICE_ACCOUNT`: a Firebase service account's JSON.
 *
 * Without them that platform's pushes are skipped, and say so in the logs.
 */

export type SendOutcome =
  | { readonly _tag: "delivered" }
  /** The token is dead; forget the phone. */
  | { readonly _tag: "gone"; readonly reason: string }
  | { readonly _tag: "skipped"; readonly reason: string };

export class PushSendError extends Schema.TaggedError<PushSendError>()("PushSendError", {
  service: Schema.Literals(["apns", "fcm"]),
  status: Schema.NullOr(Schema.Number),
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `${this.service} push failed (${this.status ?? "no response"}): ${this.reason}`;
  }
}

export class PushSender extends Context.Service<
  PushSender,
  {
    readonly send: (
      device: PushDevice,
      message: PushMessage,
    ) => Effect.Effect<SendOutcome, PushSendError>;
  }
>()("@signalbox/cloud/push/PushSender") {}

interface ApnsKey {
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
type ServiceAccount = typeof ServiceAccount.Type;
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
const signJwt = (
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

/** APNs refuses provider tokens refreshed more often than every 20 minutes or older than an hour. */
const APNS_TOKEN_TTL_SECONDS = 50 * 60;
/** Apple and Google answer in well under a second; a summary's delivery waits on this. */
const SEND_TIMEOUT = "5 seconds";
/** APNs' `apns-collapse-id` limit: a thread's newer push replaces its older one. */
const MAX_COLLAPSE_ID = 64;

const decodeAccessToken = Schema.decodeUnknownEffect(
  Schema.Struct({ access_token: Schema.NonEmptyString }),
);
const decodeReason = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ reason: Schema.String })),
);

const decodeFcmError = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Struct({
        details: Schema.optional(
          Schema.Array(Schema.Struct({ errorCode: Schema.optional(Schema.String) })),
        ),
      }),
    }),
  ),
);
/** FCM answers that mean the token will never work again. */
const DEAD_FCM_CODES = new Set(["UNREGISTERED", "SENDER_ID_MISMATCH"]);

/** APNs answers that mean the token will never work again. */
const DEAD_APNS_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

/**
 * Provider tokens by team and key, shared by every user object in the isolate:
 * Apple throttles a team that refreshes its token too often.
 */
const apnsTokens = new Map<string, { readonly iat: number; readonly jwt: string }>();

const providerToken = (key: ApnsKey) =>
  Effect.gen(function* () {
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const id = `${key.teamId}:${key.keyId}`;
    const cached = apnsTokens.get(id);
    if (cached !== undefined && now - cached.iat < APNS_TOKEN_TTL_SECONDS) return cached.jwt;
    const jwt = yield* signJwt(
      "ES256",
      Redacted.value(key.privateKey),
      { kid: key.keyId },
      { iss: key.teamId, iat: now },
    );
    apnsTokens.set(id, { iat: now, jwt });
    return jwt;
  });

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const credentials = yield* readCredentials;

  const failure =
    (service: "apns" | "fcm", reason: string, status: number | null = null) =>
    (cause: unknown) =>
      new PushSendError({ service, status, reason, cause });

  const sendApns = Effect.fn("PushSender.apns")(function* (
    key: ApnsKey,
    device: PushDevice,
    message: PushMessage,
  ) {
    if (device.bundleId === null) {
      return { _tag: "skipped", reason: "the app didn't say its bundle id" } as const;
    }
    const jwt = yield* providerToken(key).pipe(Effect.mapError(failure("apns", "signing")));
    const host =
      device.apsEnvironment === "production"
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com";
    const response = yield* HttpClientRequest.post(`${host}/3/device/${device.pushToken}`).pipe(
      HttpClientRequest.setHeaders({
        authorization: `bearer ${jwt}`,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-topic": device.bundleId,
        "apns-collapse-id": message.threadId.slice(0, MAX_COLLAPSE_ID),
      }),
      HttpClientRequest.bodyJson({
        aps: {
          alert: { title: message.title, body: message.body },
          sound: "default",
          // Notification Center stacks a thread's pushes together.
          "thread-id": `${message.environmentId}/${message.threadId}`,
        },
        environmentId: message.environmentId,
        threadId: message.threadId,
        deepLink: message.deepLink,
      }),
      Effect.flatMap(client.execute),
      Effect.timeout(SEND_TIMEOUT),
      Effect.mapError(failure("apns", "request")),
    );
    if (response.status >= 200 && response.status < 300) return { _tag: "delivered" } as const;
    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    const reason = Option.match(decodeReason(text), {
      onNone: () => text || "unknown",
      onSome: (body) => body.reason,
    });
    if (response.status === 410 || DEAD_APNS_REASONS.has(reason)) {
      return { _tag: "gone", reason } as const;
    }
    // Expired or rejected: the next push signs a fresh one.
    if (response.status === 403) apnsTokens.delete(`${key.teamId}:${key.keyId}`);
    return yield* new PushSendError({ service: "apns", status: response.status, reason });
  });

  const authorizeFcm = (account: ServiceAccount) =>
    Effect.gen(function* () {
      const iat = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const assertion = yield* signJwt(
        "RS256",
        account.private_key,
        { typ: "JWT" },
        {
          iss: account.client_email,
          scope: "https://www.googleapis.com/auth/firebase.messaging",
          aud: "https://oauth2.googleapis.com/token",
          iat,
          exp: iat + 3600,
        },
      ).pipe(Effect.mapError(failure("fcm", "signing")));
      const response = yield* client
        .execute(
          HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
            HttpClientRequest.bodyUrlParams({
              grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
              assertion,
            }),
          ),
        )
        .pipe(Effect.timeout(SEND_TIMEOUT), Effect.mapError(failure("fcm", "authorize")));
      return yield* response.json.pipe(
        Effect.flatMap(decodeAccessToken),
        Effect.map((body) => body.access_token),
        Effect.mapError(failure("fcm", "authorize", response.status)),
      );
    });
  const fcmAuthorization =
    credentials.fcm === null
      ? null
      : yield* Effect.cachedInvalidateWithTTL(authorizeFcm(credentials.fcm), "50 minutes");

  const sendFcm = Effect.fn("PushSender.fcm")(function* (
    [fcmToken, invalidateFcmToken]: NonNullable<typeof fcmAuthorization>,
    projectId: string,
    device: PushDevice,
    message: PushMessage,
  ) {
    const token = yield* fcmToken.pipe(Effect.tapError(() => invalidateFcmToken));
    // A notification message: Android shows it without the app running, and a
    // tap hands `data` to the app like an iOS push.
    const response = yield* HttpClientRequest.post(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
    ).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.bodyJson({
        message: {
          token: device.pushToken,
          notification: { title: message.title, body: message.body },
          data: {
            environmentId: message.environmentId,
            threadId: message.threadId,
            deepLink: message.deepLink,
          },
          android: {
            priority: "HIGH",
            // The high-importance channel the app creates when it asks for permission.
            notification: { tag: message.threadId, channel_id: "agent-alerts" },
            ...(device.bundleId === null ? {} : { restricted_package_name: device.bundleId }),
          },
        },
      }),
      Effect.flatMap(client.execute),
      Effect.timeout(SEND_TIMEOUT),
      Effect.mapError(failure("fcm", "request")),
    );
    if (response.status >= 200 && response.status < 300) return { _tag: "delivered" } as const;
    if (response.status === 401) yield* invalidateFcmToken;
    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    const code = Option.flatMap(decodeFcmError(text), (body) =>
      Option.fromNullishOr(body.error.details?.find((detail) => detail.errorCode)?.errorCode),
    );
    // Only these mean the token is dead; a 404 alone can be a wrong project.
    if (Option.isSome(code) && DEAD_FCM_CODES.has(code.value)) {
      return { _tag: "gone", reason: code.value } as const;
    }
    return yield* new PushSendError({ service: "fcm", status: response.status, reason: text });
  });

  return PushSender.of({
    send: (device, message) => {
      if (device.platform === "ios") {
        return credentials.apns === null
          ? Effect.succeed({ _tag: "skipped", reason: "APNs isn't configured" })
          : sendApns(credentials.apns, device, message);
      }
      return credentials.fcm === null || fcmAuthorization === null
        ? Effect.succeed({ _tag: "skipped", reason: "FCM isn't configured" })
        : sendFcm(fcmAuthorization, credentials.fcm.project_id, device, message);
    },
  });
});

/** Reads the ambient `ConfigProvider`; the user object builds one from the Worker's `env`. */
export const layer = Layer.effect(PushSender, make);
