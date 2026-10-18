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

const schedulerUrl = "https://catalog.invalid";

const recoveryReference = (target: string) => ({ __lunoraRef: target });

const recoveryTargetFor = (home: typeof CatalogRootHome.Type) =>
  home.owner._tag === "person"
    ? "personalRecovery:sync_recoverFences"
    : "organizationRecovery:sync_recoverFences";

const assertBoundRecovery = (
  target: string,
  args: Record<string, unknown>,
  home: typeof CatalogRootHome.Type,
) => {
  const expectedTarget = recoveryTargetFor(home);
  if (target !== expectedTarget) {
    throw new Error(`Catalog scheduler only accepts ${expectedTarget} for this home.`);
  }
  let targetHome: typeof CatalogRootHome.Type;
  try {
    targetHome = decodeCatalogRootHome(args.home);
  } catch {
    throw new Error("Catalog recovery schedule must include its canonical home.");
  }
  if (catalogHomeKey(targetHome) !== catalogHomeKey(home)) {
    throw new Error("Catalog recovery schedule home does not match its shard.");
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
  const route = async (
    target: string,
    args: Record<string, unknown>,
    options: RunOptions | undefined,
  ) => {
    const canonicalHome = decodeCatalogRootHome(await home());
    const shardKey = catalogHomeKey(canonicalHome);
    const reference = assertBoundRecovery(target, args, canonicalHome);
    if (options?.shardKey !== undefined && options.shardKey !== shardKey) {
      throw new Error("Catalog recovery schedule shard does not match its home.");
    }
    return {
      reference,
      options: { ...options, shardKey },
    };
  };

  return {
    cancel: scheduler.cancel,
    runAfter: async (delayMs, target, args, options) => {
      const routed = await route(target, args, options);
      return scheduler.runAfter(delayMs, routed.reference, args, routed.options);
    },
    runAt: async (timestampMs, target, args, options) => {
      const routed = await route(target, args, options);
      return scheduler.runAt(timestampMs, routed.reference, args, routed.options);
    },
  };
};

export class CatalogScheduler extends SchedulerDO {
  private readonly catalogEnv: CatalogSchedulerEnv;

  constructor(state: SchedulerDOState, env: CatalogSchedulerEnv) {
    super(state, { ...env, LUNORA_ORIGIN_URL: schedulerUrl });
    this.catalogEnv = env;
  }

  protected override async dispatch(record: ScheduleRecord): Promise<boolean | "in-progress"> {
    if (typeof record.functionPath !== "string" || typeof record.shardKey !== "string") {
      return false;
    }

    let home: typeof CatalogRootHome.Type;
    try {
      home = decodeCatalogRootHome(catalogHomeFromKey(record.shardKey));
    } catch {
      return false;
    }
    if (catalogHomeKey(home) !== record.shardKey) return false;
    try {
      assertBoundRecovery(record.functionPath, record.args, home);
    } catch {
      return false;
    }

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
