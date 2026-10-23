import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import * as Context from "effect/Context";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as Platform from "../platform.ts";
import * as PoolContainer from "./PoolContainer.ts";
import * as PoolDirectory from "./PoolDirectory.ts";
import * as PoolEngine from "./PoolEngine.ts";
import * as PoolLinks from "./PoolLinks.ts";
import * as PoolModelTransport from "./PoolModelTransport.ts";
import * as PoolObjectApi from "./poolObjectApi.ts";
import * as PoolStore from "./poolStore.ts";
import * as CliProxyApi from "./cliProxyApi.ts";

/** A local pool must never turn a miss into a request to an external pool. */
export const denyExternalFetch = Layer.succeed(
  PoolEngine.ExternalFetch,
  PoolEngine.ExternalFetch.of({
    fetch: async () => {
      throw new Error("External pool requests are disabled in a local pool.");
    },
  }),
);

export interface LocalPool {
  readonly api: PoolDirectory.PoolObjectApi & PoolDirectory.PoolModelApi;
  readonly directory: PoolDirectory.PoolDirectory["Service"];
  readonly register: Effect.Effect<
    void,
    PoolEngine.PoolRejectedError | CliProxyApi.PoolBackendError | SqlError
  >;
  readonly fetch: (request: Request) => Promise<Response>;
}

export interface LocalPoolOptions<SqlLayerError, SqlRequirements> {
  readonly sql: Layer.Layer<SqlClient.SqlClient, SqlLayerError, SqlRequirements>;
  readonly ownerId: string;
  readonly transport: PoolModelTransport.PoolModelTransport;
}

const REJECTED_POOL_REASON = "This local pool only exposes its owner's Personal pool.";

const rejectedHandle: PoolDirectory.PoolHandle = {
  create: () => Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  info: () => Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  rename: () => Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  setRouting: () => Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  setBacking: () => Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  delete: () => Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  accounts: () => Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  advice: () => Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  models: () => Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  startLogin: () => Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  loginStatus: () =>
    Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  completeLogin: () =>
    Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  cancelLogin: () =>
    Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  logoutAccount: () =>
    Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  updateAccount: () =>
    Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
  openLink: () => Effect.fail(new PoolEngine.PoolRejectedError({ reason: REJECTED_POOL_REASON })),
};

/** Builds the real pool engine around the caller's already-owned SQL client. */
export const createLocalPool = <SqlLayerError, SqlRequirements>(
  options: LocalPoolOptions<SqlLayerError, SqlRequirements>,
) =>
  Effect.gen(function* () {
    const hostConsole = yield* Console.Console;
    const sqlContext = yield* Layer.build(options.sql);
    const sql = Context.get(sqlContext, SqlClient.SqlClient);
    const personalObjectName = PoolDirectory.poolObjectName(options.ownerId, PERSONAL_POOL_ID);
    const owner = { userId: options.ownerId };
    const runtimeLayer = PoolEngine.layer.pipe(
      Layer.provideMerge(PoolLinks.layer),
      Layer.provideMerge(PoolContainer.layerUnavailable),
      Layer.provideMerge(
        Layer.mergeAll(
          PoolStore.layer,
          denyExternalFetch,
          Layer.succeed(PoolModelTransport.ActivePoolModelTransport, {
            id: options.transport.id,
            fetch: options.transport.fetch,
          }),
        ),
      ),
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(SqlClient.SqlClient, sql),
          Layer.succeed(Console.Console, hostConsole),
          Platform.layerCrypto,
        ),
      ),
    );
    const runtime = yield* Layer.build(runtimeLayer);
    const run = <A, E>(effect: Effect.Effect<A, E, PoolEngine.PoolEngine | PoolLinks.PoolLinks>) =>
      Effect.runPromiseWith(runtime)(effect);
    const engine = Context.get(runtime, PoolEngine.PoolEngine);
    yield* Effect.promise(() => run(PoolEngine.PoolEngine.use((pool) => pool.initialize)));

    const api = PoolObjectApi.makePoolObjectApi(run, async () => {});
    const personalApi = {
      ...api,
      create: (
        actor: PoolEngine.PoolActor,
        input: { readonly name: string; readonly personal: boolean },
      ) =>
        actor.userId === options.ownerId && input.name === "Personal" && input.personal
          ? api.create(actor, input)
          : Promise.resolve({ _tag: "rejected", reason: REJECTED_POOL_REASON } as const),
    };
    const directory = PoolDirectory.PoolDirectory.of({
      forPool: (objectName) =>
        objectName === personalObjectName ? PoolDirectory.handleFor(personalApi) : rejectedHandle,
    });
    const register = engine.registerLocalModelTransport(owner, options.transport);
    const fetch = (request: Request) => {
      const url = new URL(request.url);
      const path = `${url.pathname}${url.search}`;
      return run(
        engine.forwardModel(owner, path, request).pipe(Effect.map(({ response }) => response)),
      );
    };
    return { api: personalApi, directory, register, fetch } satisfies LocalPool;
  });
