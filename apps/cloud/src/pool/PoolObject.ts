// @effect-diagnostics globalDate:off - alarms are wall-clock.
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { log } from "evlog";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import * as Evlog from "../observability/Evlog.ts";
import { drainsSettled } from "../observability/evlogWorkers.ts";
import * as Platform from "../platform.ts";
import {
  POOL_OBJECT_JURISDICTION,
  type PoolModelApi,
  type PoolObjectApi,
  type PoolObjectNamespace,
} from "./PoolDirectory.ts";
import * as PoolContainer from "./PoolContainer.ts";
import * as PoolEngine from "./PoolEngine.ts";
import type { PoolLinkTarget } from "./poolLink.ts";
import * as PoolLinks from "./PoolLinks.ts";
import {
  previewLinkRegistry,
  type PreviewLinkCleanupTarget,
  type PreviewLinkRegistryNamespace,
} from "./PreviewLinkRegistry.ts";
import { makePoolObjectApi } from "./poolObjectApi.ts";
import * as PoolStore from "./poolStore.ts";
import { PoolTelemetry } from "./PoolTelemetry.ts";

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
  readonly PREVIEW_LINKS: PreviewLinkRegistryNamespace;
}

/** The `ctx.exports` loopback for `PoolStoreGateway`, which workers-types does not declare yet. */
interface PoolExports {
  readonly PoolStoreGateway: (options: { readonly props: StoreGatewayProps }) => Fetcher;
}

interface StoreGatewayProps {
  readonly objectId: string;
}

/** Keep an earlier idle or catalog alarm when another request schedules later work. */
const scheduleEarlierAlarm = async (storage: DurableObjectStorage, at: number) => {
  const current = await storage.getAlarm();
  if (current === null || at < current) await storage.setAlarm(at);
};

// The whole storage, not just `storage.sql`: migrations run in transactions.
const makeRuntime = (ctx: DurableObjectState) => {
  const emit = (action: string, fields: Record<string, unknown>) => {
    const event = { ...fields, action, pool: { id: ctx.id.toString() } };
    try {
      if (typeof fields.status === "number" && fields.status >= 500) log.error(event);
      else log.info(event);
      ctx.waitUntil(drainsSettled());
    } catch {
      // Telemetry must never fail a pool request.
    }
  };
  return ManagedRuntime.make(
    PoolEngine.layer.pipe(
      Layer.provideMerge(PoolLinks.layer),
      Layer.provideMerge(
        ctx.container
          ? PoolContainer.layerCloudflare({
              container: ctx.container,
              storeGateway: (
                ctx as unknown as { readonly exports: PoolExports }
              ).exports.PoolStoreGateway({ props: { objectId: ctx.id.toString() } }),
              wakeAt: (at) => ctx.waitUntil(scheduleEarlierAlarm(ctx.storage, at)),
              // Each container milestone is a wide event of its own.
              log: emit,
            })
          : PoolContainer.layerUnavailable,
      ),
      Layer.provideMerge(Layer.mergeAll(PoolStore.layer, PoolEngine.layerExternalFetch)),
      Layer.provideMerge(
        Layer.mergeAll(SqliteClient.layer({ storage: ctx.storage }), Platform.layerCrypto),
      ),
      Layer.provideMerge(Layer.mergeAll(Evlog.layer, Evlog.layerWaitUntil(ctx))),
      Layer.provideMerge(
        Layer.succeed(PoolTelemetry, { submit: (event) => emit(event.action, { ...event }) }),
      ),
    ),
  );
};

export class PoolObject
  extends DurableObject<PoolObjectEnv>
  implements PoolObjectApi, PoolModelApi, PoolLinkTarget, PreviewLinkCleanupTarget
{
  private readonly runtime: ReturnType<typeof makeRuntime>;
  private readonly api: PoolObjectApi & PoolModelApi & PoolLinkTarget;

  constructor(ctx: DurableObjectState, env: PoolObjectEnv) {
    super(ctx, env);
    // Created only through `jurisdiction("eu")`; anything else is a routing bug.
    if (env.LOCAL_WORKERD !== "1" && ctx.id.jurisdiction !== POOL_OBJECT_JURISDICTION) {
      throw new Error("Pool objects must live in the EU jurisdiction.");
    }
    this.runtime = makeRuntime(ctx);
    const poolObject = ctx.id.toString();
    const scheduleRefreshAlarm = async () => {
      try {
        const deadlines = await this.runtime.runPromise(
          PoolEngine.PoolEngine.use((engine) =>
            Effect.all([engine.nextModelsRefreshAt(), engine.nextUsageSampleAt()]),
          ),
        );
        for (const at of deadlines) {
          if (at !== null) await scheduleEarlierAlarm(ctx.storage, at);
        }
      } catch (cause) {
        log.error({
          action: "pool.models_alarm_schedule_failed",
          pool: { id: poolObject },
          cause: String(cause),
        });
      }
    };
    this.api = makePoolObjectApi(
      // Every span the pool records names it (#284); never its name or accounts.
      async (effect) => {
        try {
          return await this.runtime.runPromise(
            Effect.annotateSpans(effect, "pool.object", poolObject),
          );
        } finally {
          await scheduleRefreshAlarm();
        }
      },
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
        await scheduleEarlierAlarm(ctx.storage, Date.now() + PoolContainer.IDLE_TIMEOUT_MS);
      }
      await scheduleRefreshAlarm();
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

  setRouting(...args: Parameters<PoolObjectApi["setRouting"]>) {
    return this.api.setRouting(...args);
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

  advice(...args: Parameters<PoolObjectApi["advice"]>) {
    return this.api.advice(...args);
  }

  models(...args: Parameters<PoolObjectApi["models"]>) {
    return this.api.models(...args);
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

  async openLink(
    actor: Parameters<PoolObjectApi["openLink"]>[0],
    preview?: Parameters<PoolObjectApi["openLink"]>[1],
  ) {
    if (preview === undefined) return this.api.openLink(actor, preview);
    const registry = previewLinkRegistry(this.env.PREVIEW_LINKS);
    const poolId = this.ctx.id.toString();
    if (!(await registry.registerPool(preview.origin, poolId))) {
      return { _tag: "rejected", reason: "This preview has been closed." } as const;
    }
    const result = await this.api.openLink(actor, preview);
    if (result._tag !== "ok") return result;
    // Check again after the write so a close racing this call cannot leave a
    // newly created link behind the cleanup's revocation pass.
    if (!(await registry.registerPool(preview.origin, poolId))) {
      await this.removePreviewLinks(preview.origin);
      return { _tag: "rejected", reason: "This preview has been closed." } as const;
    }
    return result;
  }

  removePreviewLinks(origin: string): Promise<number> {
    return this.runtime.runPromise(
      PoolLinks.PoolLinks.use((links) => links.removePreviewLinks(origin)),
    );
  }

  /** A request on one of the pool's links (`poolLink.ts`), from the Worker. */
  async linkFetch(secret: string, request: Request): Promise<Response> {
    const link = await this.runtime.runPromise(
      PoolLinks.PoolLinks.use((links) => links.resolve(secret)),
    );
    if (link !== null && link.previewOrigin !== null) {
      const registered = await previewLinkRegistry(this.env.PREVIEW_LINKS).registerPool(
        link.previewOrigin,
        this.ctx.id.toString(),
      );
      if (!registered) return new Response("This preview has been closed.", { status: 410 });
    }
    return this.api.linkFetch(secret, request);
  }

  forwardModel(...args: Parameters<PoolModelApi["forwardModel"]>) {
    return this.api.forwardModel(...args);
  }

  /** Puts an idle container to sleep (see `PoolContainer.sleepIfIdle`). */
  override async alarm() {
    try {
      await this.runtime.runPromise(
        PoolEngine.PoolEngine.use((engine) => engine.refreshUsageAtAlarm()),
      );
    } catch (cause) {
      log.error({
        action: "pool.usage_alarm_refresh_failed",
        pool: { id: this.ctx.id.toString() },
        cause: String(cause),
      });
    }
    try {
      await this.runtime.runPromise(
        PoolEngine.PoolEngine.use((engine) => engine.refreshModelsAtAlarm()),
      );
    } catch (cause) {
      log.error({
        action: "pool.models_alarm_refresh_failed",
        pool: { id: this.ctx.id.toString() },
        cause: String(cause),
      });
    }
    const next = await this.runtime.runPromise(
      PoolContainer.PoolContainer.use((container) => container.sleepIfIdle(Date.now())).pipe(
        Evlog.withUnit("pool.alarm", { pool: { id: this.ctx.id.toString() } }),
      ),
    );
    const refresh = await this.runtime.runPromise(
      PoolEngine.PoolEngine.use((engine) => engine.nextModelsRefreshAt()),
    );
    const usage = await this.runtime.runPromise(
      PoolEngine.PoolEngine.use((engine) => engine.nextUsageSampleAt()),
    );
    const at = [next, refresh, usage]
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b)[0];
    if (at !== undefined) await this.ctx.storage.setAlarm(at);
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
