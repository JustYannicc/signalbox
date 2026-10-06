import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as CloudConfig from "../CloudConfig.ts";

/**
 * The cloud keeps no global database, so every credential names the user it
 * belongs to and is signed: the Worker verifies it with no lookup, then asks
 * that user's Durable Object whether the record behind it (session, one-time
 * grant) is still live. Sign-in state that has no user yet (the OAuth `state`,
 * a paused email verification) is sealed instead, so it can ride through the
 * browser without a server-side store.
 *
 * Tokens are `<base64url(json)>.<base64url(hmac)>`; sealed values are
 * `<base64url(iv)>.<base64url(aes-gcm)>` with the kind as associated data.
 * Both keys are derived from `SESSION_SECRET`.
 */

const UserId = Schema.String;
const ExpiresAt = Schema.Number; // epoch ms

/** An environment session. Scopes and method live on the session record. */
const SessionClaims = Schema.TaggedStruct("session", {
  u: UserId,
  sid: Schema.String,
  exp: ExpiresAt,
});
/** Authorizes WebSocket upgrades for a session until it expires, like the server's ticket. */
const TicketClaims = Schema.TaggedStruct("ticket", {
  u: UserId,
  sid: Schema.String,
  exp: ExpiresAt,
});
/** One-time pairing credential: exchanged once for a session. */
const CredentialClaims = Schema.TaggedStruct("credential", {
  u: UserId,
  gid: Schema.String,
  exp: ExpiresAt,
});
/** Native sign-in handoff: redeemed once with the app's PKCE verifier. */
const HandoffClaims = Schema.TaggedStruct("handoff", {
  u: UserId,
  gid: Schema.String,
  exp: ExpiresAt,
});

const SignedClaims = Schema.Union([SessionClaims, TicketClaims, CredentialClaims, HandoffClaims]);
export type SignedClaims = typeof SignedClaims.Type;
type SignedKind = SignedClaims["_tag"];

/** Mirrors `AccountFlow.AccountReturnTarget`, which is validated before it is sealed. */
const ReturnTarget = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("browser"), returnTo: Schema.String }),
  Schema.Struct({
    mode: Schema.Literal("native"),
    challenge: Schema.String,
    returnUrl: Schema.String,
    via: Schema.optionalKey(Schema.Literal("web")),
  }),
]);

const PendingAttempt = Schema.Struct({
  codeVerifier: Schema.String,
  origin: Schema.String,
  target: ReturnTarget,
  /**
   * Browser mode: also set as a cookie by `authorize`, so only the browser that
   * started a sign-in can finish it (no login CSRF). Native attempts are bound
   * by the app's PKCE verifier instead.
   */
  binding: Schema.optionalKey(Schema.String),
});
export type PendingAttempt = typeof PendingAttempt.Type;

/** A sign-in waiting for WorkOS to come back. Carried as the OAuth `state`. */
const AttemptSeal = Schema.TaggedStruct("attempt", { attempt: PendingAttempt, exp: ExpiresAt });
/** A sign-in paused until the user types WorkOS's emailed code. */
const VerificationSeal = Schema.TaggedStruct("verification", {
  attempt: PendingAttempt,
  pendingToken: Schema.String,
  email: Schema.String,
  exp: ExpiresAt,
});

const SealedValue = Schema.Union([AttemptSeal, VerificationSeal]);
export type SealedValue = typeof SealedValue.Type;
type SealedKind = SealedValue["_tag"];

export class CloudTokenInvalidError extends Schema.TaggedError<CloudTokenInvalidError>()(
  "CloudTokenInvalidError",
  {
    kind: Schema.String,
    reason: Schema.Literals(["malformed", "signature", "kind", "expired"]),
  },
) {
  override get message(): string {
    return `Invalid ${this.kind} token (${this.reason}).`;
  }
}

export class CloudTokens extends Context.Service<
  CloudTokens,
  {
    readonly sign: (claims: SignedClaims) => Effect.Effect<string>;
    /** Checks signature, kind and expiry. */
    readonly verify: <K extends SignedKind>(
      kind: K,
      token: string,
    ) => Effect.Effect<Extract<SignedClaims, { _tag: K }>, CloudTokenInvalidError>;
    readonly seal: (value: SealedValue) => Effect.Effect<string>;
    /** Checks integrity and kind only: callers decide what an expired value still means. */
    readonly open: <K extends SealedKind>(
      kind: K,
      sealed: string,
    ) => Effect.Effect<Extract<SealedValue, { _tag: K }>, CloudTokenInvalidError>;
  }
>()("@signalbox/cloud/auth/CloudTokens") {}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const base64UrlEncode = Base64Url.encode;

/** Copied into a fresh buffer, which WebCrypto requires. */
function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> | null {
  const decoded = Base64Url.decode(value);
  return Result.isSuccess(decoded) ? new Uint8Array(decoded.success) : null;
}

const decodeSignedJson = Schema.decodeUnknownOption(Schema.fromJsonString(SignedClaims));
const decodeSealedJson = Schema.decodeUnknownOption(Schema.fromJsonString(SealedValue));
const encodeSignedJson = Schema.encodeSync(Schema.fromJsonString(SignedClaims));
const encodeSealedJson = Schema.encodeSync(Schema.fromJsonString(SealedValue));

async function deriveKeys(secret: string) {
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  const hkdf = (info: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(0),
    info: encoder.encode(info),
  });
  const [hmac, aes] = await Promise.all([
    subtle.deriveKey(
      hkdf("signalbox-cloud/token-hmac"),
      base,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    ),
    subtle.deriveKey(hkdf("signalbox-cloud/seal"), base, { name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]),
  ]);
  return { hmac, aes };
}

const make = Effect.gen(function* () {
  const config = yield* CloudConfig.CloudConfig;
  const keys = yield* Effect.promise(() => deriveKeys(Redacted.value(config.sessionSecret)));
  const subtle = globalThis.crypto.subtle;

  const sign: CloudTokens["Service"]["sign"] = (claims) =>
    Effect.promise(async () => {
      const payload = encoder.encode(encodeSignedJson(claims));
      const signature = new Uint8Array(await subtle.sign("HMAC", keys.hmac, payload));
      return `${base64UrlEncode(payload)}.${base64UrlEncode(signature)}`;
    });

  const verify = <K extends SignedKind>(kind: K, token: string) =>
    Effect.gen(function* () {
      const invalid = (reason: CloudTokenInvalidError["reason"]) =>
        new CloudTokenInvalidError({ kind, reason });
      const [encodedPayload, encodedSignature, ...rest] = token.split(".");
      const payload = encodedPayload === undefined ? null : base64UrlDecode(encodedPayload);
      const signature = encodedSignature === undefined ? null : base64UrlDecode(encodedSignature);
      if (payload === null || signature === null || rest.length > 0) {
        return yield* invalid("malformed");
      }
      const valid = yield* Effect.promise(() =>
        subtle.verify("HMAC", keys.hmac, signature, payload),
      );
      if (!valid) return yield* invalid("signature");
      const claims = decodeSignedJson(decoder.decode(payload));
      if (claims._tag === "None") return yield* invalid("malformed");
      if (claims.value._tag !== kind) return yield* invalid("kind");
      if (claims.value.exp <= (yield* Clock.currentTimeMillis)) return yield* invalid("expired");
      return claims.value as Extract<SignedClaims, { _tag: K }>;
    });

  const seal: CloudTokens["Service"]["seal"] = (value) =>
    Effect.promise(async () => {
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(value._tag) },
        keys.aes,
        encoder.encode(encodeSealedJson(value)),
      );
      return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
    });

  const open = <K extends SealedKind>(kind: K, sealed: string) =>
    Effect.gen(function* () {
      const invalid = (reason: CloudTokenInvalidError["reason"]) =>
        new CloudTokenInvalidError({ kind, reason });
      const [encodedIv, encodedCiphertext, ...rest] = sealed.split(".");
      const iv = encodedIv === undefined ? null : base64UrlDecode(encodedIv);
      const ciphertext =
        encodedCiphertext === undefined ? null : base64UrlDecode(encodedCiphertext);
      if (iv === null || ciphertext === null || iv.length !== 12 || rest.length > 0) {
        return yield* invalid("malformed");
      }
      // The kind is associated data, so a value sealed as another kind fails here.
      const plaintext = yield* Effect.tryPromise({
        try: () =>
          subtle.decrypt(
            { name: "AES-GCM", iv, additionalData: encoder.encode(kind) },
            keys.aes,
            ciphertext,
          ),
        catch: () => invalid("signature"),
      });
      const value = decodeSealedJson(decoder.decode(plaintext));
      if (value._tag === "None") return yield* invalid("malformed");
      if (value.value._tag !== kind) return yield* invalid("kind");
      return value.value as Extract<SealedValue, { _tag: K }>;
    });

  return CloudTokens.of({ sign, verify, seal, open });
});

export const layer = Layer.effect(CloudTokens, make);
