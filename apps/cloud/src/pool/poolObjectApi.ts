import * as Effect from "effect/Effect";

import type { PoolModelApi, PoolObjectApi, PoolReply } from "./PoolDirectory.ts";
import type { ModelForwardReply } from "../models/ModelProtocol.ts";
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
): PoolObjectApi & PoolModelApi & PoolLinkTarget => {
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
    setRouting: (actor, change) => reply((engine) => engine.setRouting(actor, change)),
    setBacking: (actor, backing) => reply((engine) => engine.setBacking(actor, backing)),
    delete: async (actor) => {
      const result = await reply((engine) => done(engine.prepareDelete(actor)));
      if (result._tag === "ok") await erase();
      return result;
    },
    accounts: (actor) => reply((engine) => engine.accounts(actor)),
    advice: (actor) => reply((engine) => engine.advice(actor)),
    models: (actor) => reply((engine) => engine.models(actor)),
    startLogin: (actor, provider, flow) =>
      reply((engine) => engine.startLogin(actor, provider, flow)),
    loginStatus: (actor, state) => reply((engine) => engine.loginStatus(actor, state)),
    completeLogin: (actor, callback) =>
      reply((engine) => done(engine.completeLogin(actor, callback))),
    cancelLogin: (actor, state) => reply((engine) => engine.cancelLogin(actor, state)),
    updateAccount: (actor, name, action) =>
      reply((engine) => done(engine.updateAccount(actor, name, action))),
    openLink: (actor, preview) => reply((engine) => engine.openLink(actor, preview)),
    linkFetch: (secret, request) => run(handleLinkRequest(secret, request)),
    forwardModel: (actor, path, request, thread, trace) =>
      run(
        PoolEngine.PoolEngine.use((engine) =>
          engine.forwardModel(actor, path, request, thread, trace),
        ).pipe(
          Effect.map(({ response, upstreamMs, accountMoved }): ModelForwardReply => ({
            _tag: "forwarded",
            response,
            upstreamMs,
            ...(accountMoved === null ? {} : { accountMoved }),
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
