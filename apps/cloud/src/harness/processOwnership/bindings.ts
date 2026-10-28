import type { HarnessProcessStoreBindingProps } from "../HarnessProcessStoreBinding.ts";
import type { HarnessDurableStateBindings } from "../HarnessDurableState.ts";
import type { HarnessThreadSupervisorObject } from "../HarnessThreadSupervisorObject.ts";
import type { HarnessProcessExecutionEnvironment } from "../processPlacement/execution.ts";
import type { ProcessIncarnation } from "./incarnation.ts";
import type { ProcessFence } from "./fence.ts";
import type { ProcessStoreBindings } from "./contracts.ts";

interface FencedExecute<Result> {
  execute(command: unknown, fence?: unknown): Promise<Result>;
}

class ProcessStoreBinding<Result> {
  readonly #store: () => FencedExecute<Result>;
  readonly #incarnation: ProcessIncarnation;
  readonly #runId: string;

  constructor(store: () => FencedExecute<Result>, incarnation: ProcessIncarnation, runId: string) {
    this.#store = store;
    this.#incarnation = incarnation;
    this.#runId = runId;
  }

  async execute(command: unknown) {
    await this.#incarnation.activateRun(this.#runId);
    const fence = await this.#incarnation.assertCurrent();
    return this.#store().execute(command, fence);
  }
}

export function createProcessStoreBindings(
  environment: HarnessProcessExecutionEnvironment & Partial<HarnessDurableStateBindings>,
  incarnation: ProcessIncarnation,
  context: DurableObjectState,
) {
  const runs = new Map<string, ReturnType<ProcessStoreBindings["forRun"]>>();
  const forRun = (runId: string) => {
    const existing = runs.get(runId);
    if (existing !== undefined) return existing;
    const { HARNESS_RUN_STORE, HARNESS_FILES_STORE, HARNESS_THREAD_SUPERVISOR } = environment;
    if (HARNESS_RUN_STORE === undefined || HARNESS_FILES_STORE === undefined)
      throw new Error("Native process ownership requires all three durable stores.");
    const supervisor = () =>
      HARNESS_THREAD_SUPERVISOR.getByName(
        runId,
      ) as unknown as DurableObjectStub<HarnessThreadSupervisorObject>;
    class SupervisorBinding extends ProcessStoreBinding<
      Awaited<ReturnType<HarnessThreadSupervisorObject["execute"]>>
    > {
      async reserveReconciliation(input: unknown) {
        await incarnation.activateRun(runId);
        return supervisor().reserveReconciliation(input, await incarnation.assertCurrent());
      }
    }
    const stores = {
      runStore: new ProcessStoreBinding(
        () => HARNESS_RUN_STORE.getByName(runId),
        incarnation,
        runId,
      ),
      filesStore: new ProcessStoreBinding(
        () => HARNESS_FILES_STORE.getByName(runId),
        incarnation,
        runId,
      ),
      threadSupervisor: new SupervisorBinding(supervisor, incarnation, runId),
    };
    runs.set(runId, stores);
    return stores;
  };
  const activate = async (runId: string, fence: ProcessFence) => {
    const { HARNESS_RUN_STORE, HARNESS_FILES_STORE, HARNESS_THREAD_SUPERVISOR } = environment;
    const placement = environment.PLACEMENT_STORES.getByName(fence.owner) as unknown as {
      claimProcessFence(fence: ProcessFence): Promise<void>;
    };
    await placement.claimProcessFence(fence);
    if (HARNESS_RUN_STORE !== undefined && HARNESS_FILES_STORE !== undefined) {
      const supervisor = HARNESS_THREAD_SUPERVISOR.getByName(
        runId,
      ) as unknown as DurableObjectStub<HarnessThreadSupervisorObject>;
      await Promise.all([
        HARNESS_RUN_STORE.getByName(runId).claimProcessFence(fence),
        HARNESS_FILES_STORE.getByName(runId).claimProcessFence(fence),
        supervisor.claimProcessFence(fence),
      ]);
    }
  };
  const forFacet = async (runId: string) => {
    await incarnation.activateRun(runId);
    const fence = await incarnation.assertCurrent();
    const exports = (
      context as unknown as {
        readonly exports?: {
          readonly HarnessProcessStoreBinding?: (options: {
            readonly props: HarnessProcessStoreBindingProps;
          }) => Fetcher;
        };
      }
    ).exports;
    if (exports?.HarnessProcessStoreBinding === undefined)
      throw new Error("Process facets require HarnessProcessStoreBinding on ctx.exports.");
    const binding = (store: HarnessProcessStoreBindingProps["store"]) =>
      exports.HarnessProcessStoreBinding!({ props: { runId, store, fence } });
    return {
      runStore: binding("runStore"),
      filesStore: binding("filesStore"),
      threadSupervisor: binding("threadSupervisor"),
    };
  };
  return { forRun, forFacet, activate };
}

export async function processFacetStores(environment: HarnessDurableStateBindings, runId: string) {
  const scoped = await environment.HARNESS_C_PROCESS_STORES?.forFacet(runId);
  return {
    HARNESS_RESUME_RUN_STORE:
      scoped === undefined ? environment.HARNESS_RUN_STORE.getByName(runId) : scoped.runStore,
    HARNESS_RESUME_FILES_STORE:
      scoped === undefined ? environment.HARNESS_FILES_STORE.getByName(runId) : scoped.filesStore,
    HARNESS_RESUME_SUPERVISOR:
      scoped === undefined
        ? environment.HARNESS_THREAD_SUPERVISOR.getByName(runId)
        : scoped.threadSupervisor,
  };
}
