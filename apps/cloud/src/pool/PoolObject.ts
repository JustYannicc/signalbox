// @effect-diagnostics globalConsole:off globalDate:off - container logs go straight to Workers logs; alarms are wall-clock.
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import * as Platform from "../platform.ts";
import {
  POOL_OBJECT_JURISDICTION,
  type PoolObjectApi,
  type PoolObjectNamespace,
} from "./PoolDirectory.ts";
import * as PoolContainer from "./PoolContainer.ts";
import * as PoolEngine from "./PoolEngine.ts";
import { makePoolObjectApi } from "./poolObjectApi.ts";
import * as PoolStore from "./poolStore.ts";

/**
 * One per account pool, named by `poolObjectName`, always in the EU
 * jurisdiction. It owns the pool (see `PoolEngine`) and, for a managed pool,
 * the CLIProxyAPI container bound to it (see `PoolContainer`). `fetch` serves
 * only the container's store calls, which reach it through `PoolStoreGateway`.
 */

export interface PoolObjectEnv {
  /** Set by `vp run dev` only. Local workerd has no jurisdictions. */
  readonly LOCAL_WORKERD?: string;
  readonly POOLS: PoolObjectNamespace;
}

/** The `ctx.exports` loopback for `PoolStoreGateway`, which workers-types does not declare yet. */
interface PoolExports {
  readonly PoolStoreGateway: (options: { readonly props: StoreGatewayProps }) => Fetcher;
}

interface StoreGatewayProps {
  readonly objectId: string;
}

const log = (event: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ event, ...fields }));

/**
 * The alarm only ever puts the container to sleep, so it is always exactly
 * when the container may next sleep (see `PoolContainer.sleepIfIdle`).
 */
const ensureAlarm = async (storage: DurableObjectStorage, at: number) => {
  if ((await storage.getAlarm()) === null) await storage.setAlarm(at);
};

// The whole storage, not just `storage.sql`: migrations run in transactions.
const makeRuntime = (ctx: DurableObjectState) =>
  ManagedRuntime.make(
    PoolEngine.layer.pipe(
      Layer.provideMerge(
        ctx.container
          ? PoolContainer.layerCloudflare({
              container: ctx.container,
              storeGateway: (
                ctx as unknown as { readonly exports: PoolExports }
              ).exports.PoolStoreGateway({ props: { objectId: ctx.id.toString() } }),
              wakeAt: (at) => ctx.waitUntil(ctx.storage.setAlarm(at)),
              log,
            })
          : PoolContainer.layerUnavailable,
      ),
      Layer.provideMerge(Layer.mergeAll(PoolStore.layer, PoolEngine.layerExternalFetch)),
      Layer.provideMerge(
        Layer.mergeAll(SqliteClient.layer({ storage: ctx.storage }), Platform.layerCrypto),
      ),
    ),
  );

export class PoolObject extends DurableObject<PoolObjectEnv> implements PoolObjectApi {
  private readonly runtime: ReturnType<typeof makeRuntime>;
  private readonly api: PoolObjectApi;

  constructor(ctx: DurableObjectState, env: PoolObjectEnv) {
    super(ctx, env);
    // Created only through `jurisdiction("eu")`; anything else is a routing bug.
    if (env.LOCAL_WORKERD !== "1" && ctx.id.jurisdiction !== POOL_OBJECT_JURISDICTION) {
      throw new Error("Pool objects must live in the EU jurisdiction.");
    }
    this.runtime = makeRuntime(ctx);
    this.api = makePoolObjectApi(
      (effect) => this.runtime.runPromise(effect),
      // Erased, the object is an empty pool again, so a repeated delete still answers.
      async () => {
        await ctx.storage.deleteAll();
        await this.runtime.runPromise(PoolEngine.PoolEngine.use((engine) => engine.initialize));
      },
    );
    void ctx.blockConcurrencyWhile(async () => {
      await this.runtime.runPromise(PoolEngine.PoolEngine.use((engine) => engine.initialize));
      // A running container always has an alarm to put it to sleep.
      if (ctx.container?.running) {
        await ensureAlarm(ctx.storage, Date.now() + PoolContainer.IDLE_TIMEOUT_MS);
      }
    });
  }

  // Durable Object RPC dispatches to prototype methods, so each one is spelled out.
  create(...args: Parameters<PoolObjectApi["create"]>) {
    return this.api.create(...args);
  }

  info(...args: Parameters<PoolObjectApi["info"]>) {
    return this.api.info(...args);
  }

  rename(...args: Parameters<PoolObjectApi["rename"]>) {
    return this.api.rename(...args);
  }

  setBacking(...args: Parameters<PoolObjectApi["setBacking"]>) {
    return this.api.setBacking(...args);
  }

  delete(...args: Parameters<PoolObjectApi["delete"]>) {
    return this.api.delete(...args);
  }

  accounts(...args: Parameters<PoolObjectApi["accounts"]>) {
    return this.api.accounts(...args);
  }

  startLogin(...args: Parameters<PoolObjectApi["startLogin"]>) {
    return this.api.startLogin(...args);
  }

  loginStatus(...args: Parameters<PoolObjectApi["loginStatus"]>) {
    return this.api.loginStatus(...args);
  }

  completeLogin(...args: Parameters<PoolObjectApi["completeLogin"]>) {
    return this.api.completeLogin(...args);
  }

  cancelLogin(...args: Parameters<PoolObjectApi["cancelLogin"]>) {
    return this.api.cancelLogin(...args);
  }

  updateAccount(...args: Parameters<PoolObjectApi["updateAccount"]>) {
    return this.api.updateAccount(...args);
  }

  /** Puts an idle container to sleep (see `PoolContainer.sleepIfIdle`). */
  override async alarm() {
    const next = await this.runtime.runPromise(
      PoolContainer.PoolContainer.use((container) => container.sleepIfIdle(Date.now())),
    );
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  /** The container's store calls (see `PoolStoreGateway`). Nothing else reaches `fetch`. */
  override fetch(request: Request): Promise<Response> {
    return this.runtime.runPromise(
      PoolEngine.PoolEngine.use((engine) => engine.storeRequest(request)),
    );
  }
}

/**
 * Where a pool container's store calls land (`PoolContainer.STORE_HOST`). Each
 * container gets one bound to its own object's id, so it can only ever reach
 * its own pool's store.
 */
export class PoolStoreGateway extends WorkerEntrypoint<PoolObjectEnv, StoreGatewayProps> {
  override fetch(request: Request) {
    const { POOLS } = this.env;
    return POOLS.get(POOLS.idFromString(this.ctx.props.objectId)).fetch(request);
  }
}
