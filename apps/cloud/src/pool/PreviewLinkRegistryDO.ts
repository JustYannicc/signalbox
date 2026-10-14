import { DurableObject } from "cloudflare:workers";

import {
  makePreviewLinkRegistryApi,
  type PreviewLinkCleanupTarget,
  type PreviewLinkRegistryApi,
  type PreviewLinkRegistryStore,
} from "./PreviewLinkRegistry.ts";

interface PoolNamespace {
  readonly idFromString: (id: string) => DurableObjectId;
  readonly get: (id: DurableObjectId) => PreviewLinkCleanupTarget;
}

interface PreviewLinkRegistryEnv {
  readonly POOLS: PoolNamespace;
}

/** One small index lets production find the pool objects that hold each preview's links. */
export class PreviewLinkRegistry extends DurableObject<PreviewLinkRegistryEnv> {
  private readonly initialized: Promise<void>;
  private readonly api: PreviewLinkRegistryApi;

  constructor(ctx: DurableObjectState, env: PreviewLinkRegistryEnv) {
    super(ctx, env);
    this.initialized = ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS preview_link_origins (
        origin TEXT PRIMARY KEY,
        closed INTEGER NOT NULL DEFAULT 0
      )`);
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS preview_link_pools (
        origin TEXT NOT NULL,
        pool_object_id TEXT NOT NULL,
        PRIMARY KEY (origin, pool_object_id)
      )`);
    });
    this.api = makePreviewLinkRegistryApi(this.store(ctx), (poolId, origin) =>
      env.POOLS.get(env.POOLS.idFromString(poolId)).removePreviewLinks(origin),
    );
  }

  private store(ctx: DurableObjectState): PreviewLinkRegistryStore {
    return {
      registerPool: (origin, poolId) => {
        const sql = ctx.storage.sql;
        sql.exec(
          "INSERT INTO preview_link_origins (origin, closed) VALUES (?, 0) ON CONFLICT(origin) DO NOTHING",
          origin,
        );
        const [state] = sql
          .exec<{ readonly closed: number }>(
            "SELECT closed FROM preview_link_origins WHERE origin = ?",
            origin,
          )
          .toArray();
        if (state?.closed === 1) return false;
        sql.exec(
          "INSERT INTO preview_link_pools (origin, pool_object_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
          origin,
          poolId,
        );
        return true;
      },
      includePool: (origin, poolId) => {
        const sql = ctx.storage.sql;
        sql.exec(
          "INSERT INTO preview_link_origins (origin, closed) VALUES (?, 0) ON CONFLICT(origin) DO NOTHING",
          origin,
        );
        sql.exec(
          "INSERT INTO preview_link_pools (origin, pool_object_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
          origin,
          poolId,
        );
      },
      closeOrigin: (origin) => {
        const sql = ctx.storage.sql;
        sql.exec(
          `INSERT INTO preview_link_origins (origin, closed) VALUES (?, 1)
            ON CONFLICT(origin) DO UPDATE SET closed = 1`,
          origin,
        );
        return sql
          .exec<{ readonly pool_object_id: string }>(
            "SELECT pool_object_id FROM preview_link_pools WHERE origin = ?",
            origin,
          )
          .toArray()
          .map((row) => row.pool_object_id);
      },
      removePool: (origin, poolId) => {
        ctx.storage.sql.exec(
          "DELETE FROM preview_link_pools WHERE origin = ? AND pool_object_id = ?",
          origin,
          poolId,
        );
      },
      activateOrigin: (origin) => {
        ctx.storage.sql.exec("UPDATE preview_link_origins SET closed = 0 WHERE origin = ?", origin);
        ctx.storage.sql.exec(
          `DELETE FROM preview_link_origins WHERE origin = ?
            AND NOT EXISTS (SELECT 1 FROM preview_link_pools WHERE origin = ?)`,
          origin,
          origin,
        );
      },
      listOrigins: () =>
        ctx.storage.sql
          .exec<{ readonly origin: string }>(
            "SELECT DISTINCT origin FROM preview_link_pools ORDER BY origin",
          )
          .toArray()
          .map((row) => row.origin),
    };
  }

  async registerPool(origin: string, poolId: string): Promise<boolean> {
    await this.initialized;
    return this.api.registerPool(origin, poolId);
  }

  async cleanupOrigin(origin: string, additionalPoolIds?: ReadonlyArray<string>): Promise<number> {
    await this.initialized;
    return this.api.cleanupOrigin(origin, additionalPoolIds);
  }

  async activateOrigin(origin: string): Promise<void> {
    await this.initialized;
    return this.api.activateOrigin(origin);
  }

  async listOrigins(): Promise<ReadonlyArray<string>> {
    await this.initialized;
    return this.api.listOrigins();
  }
}
