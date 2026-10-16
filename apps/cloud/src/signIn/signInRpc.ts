import {
  type SignInCheckInput,
  type SignInFillInput,
  SignInGrantError,
  type SignInGrantInput,
  type SignInRevokeInput,
  SIGNALBOX_SIGN_IN_WS_METHODS,
} from "@t3tools/contracts/signalboxSignIn";
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";
import * as Stream from "effect/Stream";

import { DeviceSignIn } from "./DeviceSignIn.ts";
import { SignInGrants } from "./SignInGrants.ts";

const STORAGE_FAILED = "Couldn't reach your sign-in grants. Try again.";

/** A grant call as an RPC answers it: storage failures logged, a plain message for the person. */
const grantCall = <A>(effect: Effect.Effect<A, SqlError | SignInGrantError>) =>
  effect.pipe(
    Effect.catchTags({
      SqlError: (cause) =>
        Effect.logError("cloud sign-in grants storage failed", { cause }).pipe(
          Effect.andThen(Effect.fail(new SignInGrantError({ message: STORAGE_FAILED }))),
        ),
    }),
  );

/**
 * The sign-in RPCs of one connection acting for `userId`. Its check answers
 * as the login service would for a turn this person requested; its fill
 * signs one of their own tabs in on the device that asked (#586).
 */
export const makeSignInHandlers = (input: { readonly userId: string }) =>
  Effect.gen(function* () {
    const grants = yield* SignInGrants;
    const devices = yield* DeviceSignIn;
    return {
      [SIGNALBOX_SIGN_IN_WS_METHODS.subscribe]: () =>
        grants.changes.pipe(
          Stream.tapError((cause) =>
            Effect.logError("cloud sign-in grants stream failed", { cause }),
          ),
          Stream.mapError(() => new SignInGrantError({ message: STORAGE_FAILED })),
        ),
      [SIGNALBOX_SIGN_IN_WS_METHODS.grant]: (request: SignInGrantInput) =>
        grantCall(grants.grant(request)),
      [SIGNALBOX_SIGN_IN_WS_METHODS.revoke]: (request: SignInRevokeInput) =>
        grantCall(grants.revoke(request.id)),
      [SIGNALBOX_SIGN_IN_WS_METHODS.check]: (request: SignInCheckInput) =>
        grantCall(
          Effect.flatMap(
            grants.check({
              requester: input.userId,
              source: request.source,
              origin: request.origin,
            }),
            (answer) =>
              answer._tag === "refused"
                ? Effect.fail(new SignInGrantError({ message: answer.message }))
                : Effect.succeed(answer),
          ),
        ),
      [SIGNALBOX_SIGN_IN_WS_METHODS.fill]: (request: SignInFillInput) =>
        grantCall(devices.step({ ...request, requester: input.userId })),
    };
  });
