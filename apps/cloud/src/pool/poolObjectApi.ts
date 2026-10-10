import * as Effect from "effect/Effect";

import type { PoolObjectApi, PoolReply } from "./PoolDirectory.ts";
import * as PoolEngine from "./PoolEngine.ts";
import { handleLinkRequest, type PoolLinkTarget } from "./poolLink.ts";
import * as PoolLinks from "./PoolLinks.ts";
import type { SqlError } from "effect/sql/SqlError";

import type { PoolBackendError } from "./cliProxyApi.ts";

/**
 * A pool object's answers, given a way to run engine effects. The Durable
 * Object runs them on its own storage; tests run the same code in memory.
 * `erase` wipes the object once a delete is allowed.
 */
export const makePoolObjectApi = (
  run: <A, E>(
    effect: Effect.Effect<A, E, PoolEngine.PoolEngine | PoolLinks.PoolLinks>,
  ) => Promise<A>,
  erase: () => Promise<void>,
): PoolObjectApi & PoolLinkTarget => {
  const reply = <A>(
    f: (
      engine: PoolEngine.PoolEngine["Service"],
    ) => Effect.Effect<
      A,
      PoolEngine.PoolRejectedError | PoolBackendError | SqlError,
      PoolLinks.PoolLinks
    >,
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
    openLink: (actor) =>
      reply((engine) =>
        Effect.gen(function* () {
          const info = yield* engine.info(actor);
          if (info.role !== "admin") {
            return yield* new PoolEngine.PoolRejectedError({
              reason: "Only the pool's admins can move a pool into it.",
            });
          }
          return yield* PoolLinks.PoolLinks.use((links) => links.open(actor));
        }),
      ),
    linkFetch: (secret, request) => run(handleLinkRequest(secret, request)),
  };
};
