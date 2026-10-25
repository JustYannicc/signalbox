import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { trustedEnvironment } from "../account/testEnvironment.ts";

export const MAX_BODY_BYTES = 8_192;
const MAX_EXPIRY_AHEAD_MS = 60_000;
const SIGN_IN_PATH = "/api/testing/sign-in";
const encoder = new TextEncoder();
const signaturePrefix = encoder.encode(`POST\n${SIGN_IN_PATH}\n`);
const REQUEST_KEYS = ["user", "mode", "environmentId", "expiresAt"] as const;

const RequestSchema = Schema.Struct({
  user: Schema.Literals([
    "richard",
    "jared",
    "gilfoyle",
    "dinesh",
    "erlich",
    "gavin",
    "big-head",
    "fresh",
  ]),
  mode: Schema.Literals(["browser", "token", "mobile"]),
  environmentId: Schema.String,
  expiresAt: Schema.Number,
});
const decodeRequest = Schema.decodeUnknownEffect(RequestSchema);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

export type TestSignInRequest = typeof RequestSchema.Type;

export class TestSignInDeniedError extends Schema.TaggedError<TestSignInDeniedError>()(
  "TestSignInDeniedError",
  { reason: Schema.Literals(["not_found", "invalid_request", "unauthorized"]) },
) {
  override get message() {
    return "Test sign-in request denied.";
  }
}

const denied = (reason: TestSignInDeniedError["reason"]) => new TestSignInDeniedError({ reason });

const signatureBytes = (signature: string | undefined) => {
  if (signature === undefined || !/^[0-9a-fA-F]{64}$/.test(signature)) return undefined;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(signature.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const hasExactKeys = (value: unknown): value is Record<(typeof REQUEST_KEYS)[number], unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === REQUEST_KEYS.length && REQUEST_KEYS.every((key) => Object.hasOwn(value, key))
  );
};

export class TestSignInPolicy extends Context.Service<
  TestSignInPolicy,
  {
    readonly checkEnabled: Effect.Effect<void, TestSignInDeniedError>;
    readonly verify: (
      rawBody: Uint8Array,
      signature: string | undefined,
    ) => Effect.Effect<TestSignInRequest, TestSignInDeniedError>;
  }
>()("@signalbox/cloud/testSignIn/TestSignInPolicy") {}

const make = Effect.gen(function* () {
  const config = yield* Config.all({
    stage: Config.String("SIGNALBOX_STAGE").pipe(Config.option),
    environmentId: Config.String("ENVIRONMENT_ID").pipe(Config.option),
    localWorkerd: Config.String("LOCAL_WORKERD").pipe(Config.option),
    secret: Config.Redacted("E2E_SIGN_IN_SECRET").pipe(Config.option),
  });

  const expectedEnvironmentId = trustedEnvironment(
    Option.getOrUndefined(config.stage),
    Option.getOrUndefined(config.environmentId) ?? "",
    Option.getOrUndefined(config.localWorkerd),
  );
  const secret = Option.getOrUndefined(config.secret);

  if (
    expectedEnvironmentId === undefined ||
    secret === undefined ||
    Redacted.value(secret).length < 32
  ) {
    return TestSignInPolicy.of({
      checkEnabled: Effect.fail(denied("not_found")),
      verify: () => Effect.fail(denied("not_found")),
    });
  }

  const key = yield* Effect.promise(() =>
    globalThis.crypto.subtle.importKey(
      "raw",
      encoder.encode(Redacted.value(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    ),
  );

  const verify: TestSignInPolicy["Service"]["verify"] = (rawBody, signature) => {
    if (rawBody.byteLength > MAX_BODY_BYTES) return Effect.fail(denied("invalid_request"));

    const suppliedSignature = signatureBytes(signature);
    if (suppliedSignature === undefined) return Effect.fail(denied("unauthorized"));

    const signedMessage = new Uint8Array(signaturePrefix.byteLength + rawBody.byteLength);
    signedMessage.set(signaturePrefix);
    signedMessage.set(rawBody, signaturePrefix.byteLength);
    return Effect.gen(function* () {
      const validSignature = yield* Effect.tryPromise({
        try: () => globalThis.crypto.subtle.verify("HMAC", key, suppliedSignature, signedMessage),
        catch: () => denied("unauthorized"),
      });
      if (!validSignature) return yield* Effect.fail(denied("unauthorized"));

      const body = yield* Effect.try({
        try: () =>
          new TextDecoder("utf-8", { fatal: true }).decode(
            signedMessage.subarray(signaturePrefix.byteLength),
          ),
        catch: () => denied("invalid_request"),
      });
      const parsed = yield* decodeJson(body).pipe(Effect.mapError(() => denied("invalid_request")));
      if (!hasExactKeys(parsed)) return yield* Effect.fail(denied("invalid_request"));

      const request = yield* decodeRequest(parsed).pipe(
        Effect.mapError(() => denied("invalid_request")),
      );
      if (request.environmentId !== expectedEnvironmentId || !Number.isFinite(request.expiresAt)) {
        return yield* Effect.fail(denied("invalid_request"));
      }

      const now = yield* Clock.currentTimeMillis;
      if (request.expiresAt <= now || request.expiresAt > now + MAX_EXPIRY_AHEAD_MS) {
        return yield* Effect.fail(denied("invalid_request"));
      }
      return request;
    });
  };

  return TestSignInPolicy.of({ checkEnabled: Effect.void, verify });
});

export const layer = Layer.effect(TestSignInPolicy, make);
