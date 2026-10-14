import * as AccountFlow from "@signalbox/account/AccountFlow";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as CloudTokens from "../auth/CloudTokens.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import {
  PREVIEW_SETUP_AUTHORIZE_PATH,
  PREVIEW_SETUP_CALLBACK_PATH,
  PREVIEW_SETUP_REDEEM_PATH,
  PREVIEW_SETUP_START_PATH,
  PreviewSetup as PreviewSetupSchema,
  type PreviewSetup as PreviewSetupValue,
  type PreviewSetupRedeemRequest,
  PreviewSetupRedeemError,
  REDEEM_ERROR_STATUS,
} from "./previewSetupWire.ts";

/**
 * A preview deployment starting from the signed-in user's production setup,
 * with no click and no secret shared with pull request builds:
 *
 * 1. Signing in to a preview ends at `start` (`signInLocation`), which seals a
 *    verifier into a state and sends the browser to production's `authorize`.
 * 2. Production checks the origin is an allowed preview's. Signed in there, it
 *    records a one-time claim bound to that user, origin and the verifier's
 *    challenge, and sends the browser back to the preview's `callback` with
 *    it. Not signed in, it sends the browser back without one.
 * 3. The preview checks the state is its own and names the user signed in
 *    here, then redeems the claim with production (`redeem`) for the setup,
 *    and takes it in (`UserPreviewSetup.apply`).
 *
 * Every step that fails just lands the browser where sign-in was going.
 */

/** How long a trip through production may take before the preview gives up on it. */
const STATE_TTL_MS = 10 * 60_000;
/** Taking a setup in waits for every pool to answer; sign-in waits no longer than this. */
const APPLY_TIMEOUT = "20 seconds";

/**
 * - `PREVIEW_SETUP_SOURCE` (previews): production's origin, where each user's
 *   setup comes from. Unset, sign-in goes straight on.
 * - `PREVIEW_SETUP_ORIGINS` (production): the preview origins that may ask for
 *   a setup, comma-separated, `*` standing for a number:
 *   `https://preview-*.signalbox.run`. Unset, none may.
 */
export class PreviewSetupConfig extends Context.Service<
  PreviewSetupConfig,
  {
    readonly source: string | null;
    readonly allows: (origin: string) => boolean;
  }
>()("@signalbox/cloud/previewSetup/PreviewSetup/PreviewSetupConfig") {}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export const makeConfig = (input: { readonly source?: string; readonly origins?: string }) => {
  const patterns = (input.origins ?? "")
    .split(",")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
    .map((pattern) => new RegExp(`^${pattern.split("*").map(escapeRegExp).join("[0-9]+")}$`, "u"));
  const source = input.source?.trim().replace(/\/+$/u, "");
  return PreviewSetupConfig.of({
    source: source ? source : null,
    allows: (origin) => patterns.some((pattern) => pattern.test(origin)),
  });
};

export const layerConfig = Layer.effect(
  PreviewSetupConfig,
  Effect.gen(function* () {
    const source = yield* Config.String("PREVIEW_SETUP_SOURCE").pipe(Config.option);
    const origins = yield* Config.String("PREVIEW_SETUP_ORIGINS").pipe(Config.option);
    return makeConfig({
      ...(Option.isSome(source) ? { source: source.value } : {}),
      ...(Option.isSome(origins) ? { origins: origins.value } : {}),
    });
  }),
);

/** Where a browser sign-in lands: through `start` on a preview, straight on anywhere else. */
export const signInLocation = (config: PreviewSetupConfig["Service"], returnTo: string) =>
  config.source === null
    ? returnTo
    : `${PREVIEW_SETUP_START_PATH}?${new URLSearchParams({ returnTo })}`;

/** How a preview reaches production's `redeem`. Tests reach another cloud in memory. */
export class PreviewSetupSource extends Context.Service<
  PreviewSetupSource,
  {
    readonly redeem: (
      request: PreviewSetupRedeemRequest,
    ) => Effect.Effect<PreviewSetupValue, PreviewSetupRedeemError>;
  }
>()("@signalbox/cloud/previewSetup/PreviewSetup/PreviewSetupSource") {}

const decodeSetup = Schema.decodeUnknownEffect(PreviewSetupSchema);
const reasonOf = (status: number) =>
  (Object.keys(REDEEM_ERROR_STATUS) as Array<PreviewSetupRedeemError["reason"]>).find(
    (reason) => REDEEM_ERROR_STATUS[reason] === status,
  ) ?? "failed";

export const layerSourceHttp = Layer.effect(
  PreviewSetupSource,
  Effect.gen(function* () {
    const config = yield* PreviewSetupConfig;
    const client = yield* HttpClient.HttpClient;
    const fail = (reason: PreviewSetupRedeemError["reason"]) =>
      Effect.fail(new PreviewSetupRedeemError({ reason }));
    return PreviewSetupSource.of({
      redeem: (request) =>
        Effect.gen(function* () {
          if (config.source === null) return yield* fail("rejected");
          const response = yield* client.execute(
            HttpClientRequest.post(`${config.source}${PREVIEW_SETUP_REDEEM_PATH}`).pipe(
              HttpClientRequest.bodyJsonUnsafe(request),
            ),
          );
          if (response.status !== 200) {
            return yield* fail(reasonOf(response.status));
          }
          return yield* decodeSetup(yield* response.json);
        }).pipe(
          Effect.scoped,
          // The body holds pool link tokens: no cause from here may carry it into a log.
          Effect.catchTags({
            HttpClientError: () => fail("failed"),
            SchemaError: () => fail("failed"),
          }),
        ),
    });
  }),
);

/** A path on this origin, or `/`: `start` must not redirect anywhere else. */
const sameOriginPath = (value: string | null) =>
  value !== null && AccountFlow.isSameOriginPath(value) ? value : "/";

export class PreviewSetup extends Context.Service<
  PreviewSetup,
  {
    /** A preview, after sign-in: where to send the browser next. */
    readonly start: (input: {
      readonly userId: string | null;
      readonly origin: string;
      readonly returnTo: string | null;
    }) => Effect.Effect<string>;
    /** Production: where to send the browser back to, or null when `origin` isn't an allowed preview. */
    readonly authorize: (input: {
      readonly userId: string | null;
      readonly origin: string;
      readonly challenge: string;
      readonly state: string;
    }) => Effect.Effect<string | null, UserDirectory.UserObjectError>;
    /** A preview, back from production: takes the setup in, then answers where sign-in was going. */
    readonly callback: (input: {
      readonly userId: string | null;
      readonly origin: string;
      readonly state: string;
      readonly code: string | null;
    }) => Effect.Effect<string>;
    /** Production: the setup a preview's claim names. */
    readonly redeem: (
      request: PreviewSetupRedeemRequest,
    ) => Effect.Effect<PreviewSetupValue, PreviewSetupRedeemError>;
  }
>()("@signalbox/cloud/previewSetup/PreviewSetup") {}

export const layer = Layer.effect(
  PreviewSetup,
  Effect.gen(function* () {
    const config = yield* PreviewSetupConfig;
    const tokens = yield* CloudTokens.CloudTokens;
    const users = yield* UserDirectory.UserDirectory;
    const source = yield* PreviewSetupSource;

    const start: PreviewSetup["Service"]["start"] = (input) =>
      Effect.gen(function* () {
        const returnTo = sameOriginPath(input.returnTo);
        if (config.source === null || input.userId === null) return returnTo;
        const verifier = AccountFlow.randomToken();
        const state = yield* tokens.seal({
          _tag: "preview-setup-state",
          u: input.userId,
          returnTo,
          verifier,
          exp: (yield* Clock.currentTimeMillis) + STATE_TTL_MS,
        });
        const query = new URLSearchParams({
          origin: input.origin,
          challenge: AccountFlow.pkceChallenge(verifier),
          state,
        });
        return `${config.source}${PREVIEW_SETUP_AUTHORIZE_PATH}?${query}`;
      });

    const authorize: PreviewSetup["Service"]["authorize"] = (input) =>
      Effect.gen(function* () {
        if (!config.allows(input.origin)) return null;
        const back = new URL(PREVIEW_SETUP_CALLBACK_PATH, input.origin);
        back.searchParams.set("state", input.state);
        // Not signed in here, or a malformed ask: back without a claim, and the preview goes on.
        if (input.userId === null || !AccountFlow.BASE64URL_SHA256.test(input.challenge)) {
          return back.toString();
        }
        const claim = yield* users
          .forUser(input.userId)
          .issuePreviewSetupCode({ origin: input.origin, challenge: input.challenge });
        const code = yield* tokens.sign({
          _tag: "preview-setup",
          u: input.userId,
          gid: claim.gid,
          o: input.origin,
          exp: claim.expiresAt,
        });
        back.searchParams.set("code", code);
        return back.toString();
      });

    const callback: PreviewSetup["Service"]["callback"] = (input) =>
      Effect.gen(function* () {
        const sealed = yield* tokens
          .open("preview-setup-state", input.state)
          .pipe(Effect.option, Effect.map(Option.getOrNull));
        if (sealed === null) return "/";
        const now = yield* Clock.currentTimeMillis;
        // Someone else signed in here meanwhile, or production had nobody: nothing to take.
        if (
          config.source === null ||
          sealed.exp <= now ||
          input.userId !== sealed.u ||
          input.code === null
        ) {
          return sealed.returnTo;
        }
        const sourceOrigin = config.source;
        yield* source
          .redeem({
            code: input.code,
            verifier: sealed.verifier,
            origin: input.origin,
            userId: sealed.u,
          })
          .pipe(
            Effect.flatMap((setup) =>
              users.forUser(sealed.u).importPreviewSetup({ setup, source: sourceOrigin }),
            ),
            Effect.timeout(APPLY_TIMEOUT),
            // Whatever went wrong, sign-in still lands; the next one tries again.
            Effect.catchCause((cause) =>
              Effect.logWarning("preview setup was not taken in", Cause.pretty(cause)),
            ),
          );
        return sealed.returnTo;
      });

    const redeem: PreviewSetup["Service"]["redeem"] = (request) =>
      Effect.gen(function* () {
        const reject = (reason: PreviewSetupRedeemError["reason"]) =>
          Effect.fail(new PreviewSetupRedeemError({ reason }));
        if (!config.allows(request.origin)) return yield* reject("rejected");
        const claims = yield* tokens
          .verify("preview-setup", request.code)
          .pipe(Effect.mapError(() => new PreviewSetupRedeemError({ reason: "expired" })));
        if (claims.o !== request.origin || claims.u !== request.userId) {
          return yield* reject("rejected");
        }
        const redemption = yield* users
          .forUser(claims.u)
          .redeemPreviewSetup({
            gid: claims.gid,
            origin: claims.o,
            challenge: AccountFlow.pkceChallenge(request.verifier),
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logError("preview setup redeem failed", { cause: error }).pipe(
                Effect.andThen(reject("failed")),
              ),
            ),
          );
        if (redemption._tag === "expired") return yield* reject("expired");
        return redemption.setup;
      });

    return PreviewSetup.of({ start, authorize, callback, redeem });
  }),
);
