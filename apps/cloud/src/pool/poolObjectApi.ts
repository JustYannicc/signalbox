import * as Effect from "effect/Effect";

import type { ModelForwardReply, PoolModelApi, PoolObjectApi, PoolReply } from "./PoolDirectory.ts";
import * as PoolEngine from "./PoolEngine.ts";
import type { SqlError } from "effect/sql/SqlError";

import type { PoolBackendError } from "./cliProxyApi.ts";

/**
 * A pool object's answers, given a way to run engine effects. The Durable
 * Object runs them on its own storage; tests run the same code in memory.
 * `erase` wipes the object once a delete is allowed.
 */
export const makePoolObjectApi = (
  run: <A, E>(effect: Effect.Effect<A, E, PoolEngine.PoolEngine>) => Promise<A>,
  erase: () => Promise<void>,
): PoolObjectApi & PoolModelApi => {
  const reply = <A>(
    f: (
      engine: PoolEngine.PoolEngine["Service"],
    ) => Effect.Effect<A, PoolEngine.PoolRejectedError | PoolBackendError | SqlError>,
  ): Promise<PoolReply<A>> =>
    run(
      PoolEngine.PoolEngine.use(f).pipe(
        Effect.map((value): PoolReply<A> => ({ _tag: "ok", value })),
        Effect.catchTags({
          PoolRejectedError: (error: PoolEngine.PoolRejectedError) =>
            Effect.succeed({ _tag: "rejected", reason: error.reason } as const),
          PoolBackendError: (error: PoolBackendError) =>
            Effect.logWarning("pool backend call failed", error.detail, error.cause).pipe(
              Effect.as({ _tag: "rejected", reason: error.detail } as const),
            ),
        }),
      ),
    );
  const done = <E>(effect: Effect.Effect<void, E>) => Effect.as(effect, null);
  return {
    create: (actor, input) => reply((engine) => engine.create(actor, input)),
    info: (actor) => reply((engine) => engine.info(actor)),
    rename: (actor, name) => reply((engine) => engine.rename(actor, name)),
    setBacking: (actor, backing) => reply((engine) => engine.setBacking(actor, backing)),
    delete: async (actor) => {
      const result = await reply((engine) => done(engine.prepareDelete(actor)));
      if (result._tag === "ok") await erase();
      return result;
    },
    accounts: (actor) => reply((engine) => engine.accounts(actor)),
    startLogin: (actor, provider) => reply((engine) => engine.startLogin(actor, provider)),
    loginStatus: (actor, state) => reply((engine) => engine.loginStatus(actor, state)),
    completeLogin: (actor, url) => reply((engine) => done(engine.completeLogin(actor, url))),
    cancelLogin: (actor, state) => reply((engine) => done(engine.cancelLogin(actor, state))),
    updateAccount: (actor, name, action) =>
      reply((engine) => done(engine.updateAccount(actor, name, action))),
    forwardModel: (actor, path, request) =>
      run(
        PoolEngine.PoolEngine.use((engine) => engine.forwardModel(actor, path, request)).pipe(
          Effect.map(({ response, upstreamMs }): ModelForwardReply => ({
            _tag: "forwarded",
            response,
            upstreamMs,
          })),
          Effect.catchTags({
            PoolRejectedError: (error: PoolEngine.PoolRejectedError) =>
              Effect.succeed({ _tag: "denied", reason: error.reason } as const),
            PoolBackendError: (error: PoolBackendError) =>
              Effect.logWarning("pool model request failed", error.detail, error.cause).pipe(
                Effect.as({ _tag: "failed", reason: error.detail } as const),
              ),
          }),
        ),
      ),
  };
};
