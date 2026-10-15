import { type AuthEnvironmentScope, AuthStandardClientScopes } from "@t3tools/contracts";
import {
  PersonalKeyError,
  type PersonalKeyCreateInput,
  SIGNALBOX_KEYS_WS_METHODS,
} from "@t3tools/contracts/signalboxKeys";
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";

import * as CloudTokens from "../auth/CloudTokens.ts";
import * as LocalKeys from "../localKeys/LocalKeys.ts";

/** A key change as an RPC answers it: storage failures logged, a plain message for the person. */
const keyCall = <A>(effect: Effect.Effect<A, SqlError | PersonalKeyError>) =>
  effect.pipe(
    Effect.catchTags({
      SqlError: (cause) =>
        Effect.logError("cloud personal keys storage failed", { cause }).pipe(
          Effect.andThen(
            Effect.fail(new PersonalKeyError({ message: "Couldn't change your keys. Try again." })),
          ),
        ),
    }),
  );

/**
 * The personal key RPCs of one connection acting for `userId`. A new key
 * never holds more than the caller does, so a narrow key can't mint a wider one.
 */
export const makeKeysHandlers = (input: {
  readonly userId: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}) =>
  Effect.gen(function* () {
    const keys = yield* LocalKeys.LocalKeys;
    const tokens = yield* CloudTokens.CloudTokens;
    const view = Effect.map(keys.list, (list) => ({
      keys: list.map(({ id, label, scopes, model, createdAt, lastUsedAt }) => ({
        id,
        label,
        scopes,
        model,
        createdAt,
        lastUsedAt,
      })),
    }));
    const create = (request: PersonalKeyCreateInput) =>
      Effect.gen(function* () {
        const beyond = request.scopes.filter(
          (scope) =>
            !input.scopes.includes(scope) ||
            !(AuthStandardClientScopes as ReadonlyArray<string>).includes(scope),
        );
        if (beyond.length > 0) {
          return yield* new PersonalKeyError({
            message: `A key can't hold what you don't: ${beyond.join(", ")}.`,
          });
        }
        if (request.scopes.length === 0 && !request.model) {
          return yield* new PersonalKeyError({
            message: "Give the key API scopes, model access, or both.",
          });
        }
        const created = yield* keys.create(request.label, {
          scopes: request.scopes,
          model: request.model,
        });
        if (created._tag === "limit") {
          return yield* new PersonalKeyError({ message: "Revoke a key you no longer use first." });
        }
        const key = yield* LocalKeys.signLocalKey(input.userId, created.secret).pipe(
          Effect.provideService(CloudTokens.CloudTokens, tokens),
        );
        return { key };
      });
    return {
      [SIGNALBOX_KEYS_WS_METHODS.list]: () => keyCall(view),
      [SIGNALBOX_KEYS_WS_METHODS.create]: (request: PersonalKeyCreateInput) =>
        keyCall(create(request)),
      [SIGNALBOX_KEYS_WS_METHODS.revoke]: ({ id }: { readonly id: string }) =>
        keyCall(Effect.andThen(keys.revoke(id), view)),
    };
  });
