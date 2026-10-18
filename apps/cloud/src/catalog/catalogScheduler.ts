import {
  SchedulerDO,
  createScheduler,
  type LunoraSchedulerOptions,
  type RunOptions,
  type ScheduleRecord,
  type Scheduler,
  type SchedulerDOState,
  type SchedulerEnv,
} from "@lunora/scheduler";
import { createShardClient, type ShardNamespaceLike } from "lunorash/runtime";

import { catalogHomeFromKey, catalogHomeKey } from "./catalogHome.ts";
import {
  catalogHomeNamespace,
  decodeCatalogRootHome,
  type CatalogHomeNamespace,
} from "./catalogObjects.ts";
import type { CatalogRootHome } from "./catalogHomeSchema.ts";

export interface CatalogSchedulerEnv extends SchedulerEnv {
  readonly CATALOG_SCHEDULER: LunoraSchedulerOptions["namespace"];
  readonly HOMES: CatalogHomeNamespace;
  readonly LOCAL_WORKERD?: string;
}

/** Native recovery schedules always return to the physical home that owns their rows. */
export interface CatalogSchedulerClient {
  readonly cancel: Scheduler["cancel"];
  readonly runAfter: (
    delayMs: number,
    target: string,
    args: Record<string, unknown>,
    options?: RunOptions,
  ) => Promise<string>;
  readonly runAt: (
    timestampMs: number,
    target: string,
    args: Record<string, unknown>,
    options?: RunOptions,
  ) => Promise<string>;
}

const recoveryTarget = "personalRecovery:sync_recoverFences";
const schedulerUrl = "https://catalog.invalid";

const recoveryReference = (target: string) => ({ __lunoraRef: target });

const assertRecoveryTarget = (target: string) => {
  if (target !== recoveryTarget) {
    throw new Error(`Catalog scheduler only accepts ${recoveryTarget}.`);
  }
  return recoveryReference(target);
};

export const catalogSchedulerFor = (
  env: CatalogSchedulerEnv,
  home: () => Promise<typeof CatalogRootHome.Type>,
): CatalogSchedulerClient => {
  const scheduler = createScheduler({
    namespace: env.CATALOG_SCHEDULER,
    ...(env.LOCAL_WORKERD === "1" ? {} : { jurisdiction: "eu" }),
  });
  const routedOptions = async (options: RunOptions | undefined) => ({
    ...options,
    shardKey: catalogHomeKey(await home()),
  });

  return {
    cancel: scheduler.cancel,
    runAfter: async (delayMs, target, args, options) =>
      scheduler.runAfter(delayMs, assertRecoveryTarget(target), args, await routedOptions(options)),
    runAt: async (timestampMs, target, args, options) =>
      scheduler.runAt(
        timestampMs,
        assertRecoveryTarget(target),
        args,
        await routedOptions(options),
      ),
  };
};

export class CatalogScheduler extends SchedulerDO {
  private readonly catalogEnv: CatalogSchedulerEnv;

  constructor(state: SchedulerDOState, env: CatalogSchedulerEnv) {
    super(state, { ...env, LUNORA_ORIGIN_URL: schedulerUrl });
    this.catalogEnv = env;
  }

  protected override async dispatch(record: ScheduleRecord): Promise<boolean | "in-progress"> {
    if (record.functionPath !== recoveryTarget || typeof record.shardKey !== "string") return false;

    let home: typeof CatalogRootHome.Type;
    try {
      home = decodeCatalogRootHome(catalogHomeFromKey(record.shardKey));
    } catch {
      return false;
    }
    if (catalogHomeKey(home) !== record.shardKey) return false;

    const localWorkerd = this.catalogEnv.LOCAL_WORKERD === "1";
    const namespace = catalogHomeNamespace(this.catalogEnv.HOMES, localWorkerd);
    try {
      await createShardClient(namespace as unknown as ShardNamespaceLike, {
        system: true,
      })
        .forShard(record.shardKey)
        .call(record.functionPath, record.args);
      return true;
    } catch {
      return false;
    }
  }
}
