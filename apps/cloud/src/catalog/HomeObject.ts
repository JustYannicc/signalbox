import { installDeliveryFence, type ShardDOState } from "lunorash/do";
import { createShardDO } from "./lunora/_generated/shard.js";

import {
  CATALOG_HOME_BIND_HEADER,
  CATALOG_HOME_BIND_PATH,
  CATALOG_HOME_JURISDICTION,
  assertCatalogHomeId,
  catalogHomeNamespace,
  catalogRelaySecret,
  catalogRuntimePorts,
  decodeCatalogRootHome,
  makeCatalogDeliveryAuthorization,
  nativeCatalogScope,
  type CatalogObjectEnv,
} from "./catalogObjects.ts";
import { catalogHomeKey } from "./catalogHome.ts";
import { catalogSchedulerFor, type CatalogSchedulerEnv } from "./catalogScheduler.ts";
import { runtimePorts } from "./lunora/env.ts";
import { makeStorageObserver } from "../observability/DurableObjectStorage.ts";

const HOME_RECORD_KEY = "catalog:home:v1";
const MAX_BIND_BODY_BYTES = 32 * 1024;

interface BoundHomeRecord {
  readonly version: 1;
  readonly home: ReturnType<typeof decodeCatalogRootHome>;
  readonly homeKey: string;
  readonly installedEpoch: number;
}

interface HomeObjectState {
  readonly env: CatalogObjectEnv;
  readonly ctx: ShardDOState & DurableObjectState;
  record?: BoundHomeRecord;
  home?: BoundHomeRecord["home"];
  homeKey?: string;
  installedEpoch: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeEpoch = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const readRecord = (value: unknown): BoundHomeRecord => {
  if (!isRecord(value) || value.version !== 1 || typeof value.homeKey !== "string") {
    throw new Error("Catalog home identity storage is invalid.");
  }
  const home = decodeCatalogRootHome(value.home);
  const homeKey = catalogHomeKey(home);
  if (value.homeKey !== homeKey || !safeEpoch(value.installedEpoch)) {
    throw new Error("Catalog home identity storage is invalid.");
  }
  return { version: 1, home, homeKey, installedEpoch: value.installedEpoch };
};

const makeShard = createShardDO({
  deliveryAuthorization: (environment) =>
    makeCatalogDeliveryAuthorization(runtimePorts(environment)),
  scheduler: (environment) => {
    const ports = runtimePorts(environment);
    return catalogSchedulerFor(environment as CatalogSchedulerEnv, ports.home);
  },
});

/** One physical shard per canonical Catalog root; its namespace is private to Worker bindings. */
export class HomeObject extends makeShard {
  private readonly initialized: Promise<void>;
  private readonly objectState: HomeObjectState;
  private storageObserver: (() => void) | undefined;

  constructor(state: ShardDOState, environment: unknown) {
    const env = environment as CatalogObjectEnv;
    const localWorkerd = env.LOCAL_WORKERD === "1";
    const ctx = state as ShardDOState & DurableObjectState;
    if (!localWorkerd && ctx.id.jurisdiction !== CATALOG_HOME_JURISDICTION) {
      throw new Error("Catalog home objects must live in the EU jurisdiction.");
    }

    const runtimeEnv = { ...env, LUNORA_RELAY_SECRET: catalogRelaySecret(env) };
    const objectState: HomeObjectState = { env: runtimeEnv, ctx, installedEpoch: 0 };
    let initialized = Promise.resolve();
    const getHome = async () => {
      await initialized;
      if (objectState.home === undefined) throw new Error("Catalog home is not bound.");
      return objectState.home;
    };
    const getHomeKey = () => {
      if (objectState.homeKey === undefined) throw new Error("Catalog home is not bound.");
      return objectState.homeKey;
    };
    const install = async (fence: { readonly scope: string; readonly epoch: number }) => {
      await initialized;
      const home = await getHome();
      const homeKey = catalogHomeKey(home);
      if (fence.scope !== homeKey || !safeEpoch(fence.epoch)) {
        throw new Error("Catalog authorization fence does not match its home.");
      }

      objectState.installedEpoch = Math.max(objectState.installedEpoch, fence.epoch);
      const namespace = catalogHomeNamespace(runtimeEnv.HOMES, localWorkerd);
      await installDeliveryFence(namespace.get(ctx.id), {
        env: runtimeEnv,
        fence: { scope: await nativeCatalogScope(homeKey), epoch: fence.epoch },
        shardKey: homeKey,
      });

      const next = await ctx.storage.transaction(async (transaction) => {
        const current = await transaction.get<unknown>(HOME_RECORD_KEY);
        const persisted = current === undefined ? objectState.record : readRecord(current);
        if (persisted === undefined || persisted.homeKey !== homeKey) {
          throw new Error("Catalog home identity storage is unavailable.");
        }
        const nextRecord = {
          ...persisted,
          installedEpoch: Math.max(
            objectState.installedEpoch,
            persisted.installedEpoch,
            fence.epoch,
          ),
        } satisfies BoundHomeRecord;
        await transaction.put(HOME_RECORD_KEY, nextRecord);
        return nextRecord;
      });
      objectState.record = next;
      objectState.installedEpoch = next.installedEpoch;
    };

    const ports = catalogRuntimePorts({
      env: runtimeEnv,
      getHome,
      getHomeKey,
      getEpoch: () => objectState.installedEpoch,
      install,
    });
    super(state, { ...runtimeEnv, CATALOG_RUNTIME: ports });

    this.objectState = objectState;
    this.initialized = ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<unknown>(HOME_RECORD_KEY);
      if (stored === undefined) return;
      const decoded = readRecord(stored);
      assertCatalogHomeId(
        catalogHomeNamespace(runtimeEnv.HOMES, localWorkerd),
        ctx.id,
        decoded.home,
      );
      objectState.record = decoded;
      objectState.home = decoded.home;
      objectState.homeKey = decoded.homeKey;
      objectState.installedEpoch = decoded.installedEpoch;
    });
    initialized = this.initialized;
  }

  override async fetch(request: Request): Promise<Response> {
    await this.initialized;
    try {
      const url = new URL(request.url);
      if (url.pathname === CATALOG_HOME_BIND_PATH) return await this.bindHome(request);
      return await super.fetch(request);
    } finally {
      this.observeStorage();
    }
  }

  // The native factory types its concrete class as the abstract ShardDO base.
  override handleRpc(...args: Parameters<InstanceType<typeof makeShard>["handleRpc"]>) {
    return makeShard.prototype.handleRpc.apply(this, args);
  }

  override async alarm(): Promise<void> {
    try {
      await super.alarm();
    } finally {
      this.observeStorage();
    }
  }

  private observeStorage() {
    const { home, ctx, env } = this.objectState;
    if (home === undefined) return;
    this.storageObserver ??= makeStorageObserver(
      ctx,
      {
        kind: "home",
        level: home.owner._tag === "person" ? "person" : "organization",
      },
      env,
    );
    this.storageObserver();
  }

  private async bindHome(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed.", { status: 405 });
    const { env, ctx } = this.objectState;
    if (request.headers.get(CATALOG_HOME_BIND_HEADER) !== catalogRelaySecret(env)) {
      return new Response("Forbidden.", { status: 403 });
    }

    let body: unknown;
    try {
      const text = await request.text();
      if (text.length > MAX_BIND_BODY_BYTES) {
        return new Response("Request too large.", { status: 413 });
      }
      body = JSON.parse(text) as unknown;
    } catch {
      return new Response("Invalid request.", { status: 400 });
    }
    if (!isRecord(body) || !Object.hasOwn(body, "home")) {
      return new Response("Invalid request.", { status: 400 });
    }

    let home: BoundHomeRecord["home"];
    let homeKey: string;
    try {
      home = decodeCatalogRootHome(body.home);
      homeKey = assertCatalogHomeId(
        catalogHomeNamespace(env.HOMES, env.LOCAL_WORKERD === "1"),
        ctx.id,
        home,
      );
    } catch {
      return new Response("Catalog home identity is invalid.", { status: 409 });
    }

    let next: BoundHomeRecord;
    try {
      next = await ctx.storage.transaction(async (transaction) => {
        const existing = await transaction.get<unknown>(HOME_RECORD_KEY);
        if (existing !== undefined) {
          const decoded = readRecord(existing);
          if (decoded.homeKey !== homeKey)
            throw new Error("Catalog home identity is already bound.");
          return decoded;
        }
        const initial = { version: 1, home, homeKey, installedEpoch: 0 } satisfies BoundHomeRecord;
        await transaction.put(HOME_RECORD_KEY, initial);
        return initial;
      });
    } catch {
      return new Response("Catalog home identity is already bound.", { status: 409 });
    }

    this.objectState.home = next.home;
    this.objectState.homeKey = next.homeKey;
    this.objectState.record = next;
    this.objectState.installedEpoch = Math.max(
      this.objectState.installedEpoch,
      next.installedEpoch,
    );
    return new Response(null, { status: 204 });
  }
}
