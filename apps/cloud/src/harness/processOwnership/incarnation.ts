import {
  fenceHistoryKey,
  localFenceKey,
  readProcessFence,
  sameProcessFence,
  type ProcessFence,
} from "./fence.ts";

const runsKey = "harness-process-incarnation/v1/runs";

export class ProcessIncarnation {
  readonly ready: Promise<ProcessFence>;
  readonly #storage: DurableObjectStorage;
  readonly #runs = new Map<string, Promise<void>>();
  #activateRun: ((runId: string, fence: ProcessFence) => Promise<void>) | undefined;

  constructor(storage: DurableObjectStorage, owner: string, nonce: string) {
    this.#storage = storage;
    this.ready = storage.transaction(async (transaction) => {
      const saved = await transaction.get<ProcessFence>(localFenceKey);
      const previous = saved === undefined ? undefined : readProcessFence(saved);
      if (previous !== undefined && previous.owner !== owner)
        throw new Error("The durable process shard belongs to another owner.");
      const fence = readProcessFence({
        owner,
        incarnation: (previous?.incarnation ?? 0) + 1,
        nonce,
      });
      await transaction.put(localFenceKey, fence);
      await transaction.put(fenceHistoryKey(fence.incarnation), fence);
      return fence;
    });
  }

  async assertCurrent(transaction?: DurableObjectTransaction) {
    const fence = await this.ready;
    const current = await (transaction ?? this.#storage).get<ProcessFence>(localFenceKey);
    if (current === undefined || !sameProcessFence(readProcessFence(current), fence))
      throw new Error("This process-shard incarnation has been fenced out.");
    return fence;
  }

  async transaction<A>(operation: (transaction: DurableObjectTransaction) => Promise<A>) {
    await this.ready;
    return this.#storage.transaction(async (transaction) => {
      await this.assertCurrent(transaction);
      return operation(transaction);
    });
  }

  async activateRuns(activate: (runId: string, fence: ProcessFence) => Promise<void>) {
    this.#activateRun = activate;
    await this.assertCurrent();
    const runs = (await this.#storage.get<string[]>(runsKey)) ?? [];
    await Promise.all(runs.map((runId) => this.activateRun(runId)));
  }

  activateRun(runId: string) {
    const existing = this.#runs.get(runId);
    if (existing !== undefined) return existing;
    const activated = this.#registerRun(runId);
    this.#runs.set(runId, activated);
    return activated;
  }

  async #registerRun(runId: string) {
    if (!runId) throw new Error("A process fence requires its exact run.");
    const fence = await this.assertCurrent();
    await this.transaction(async (transaction) => {
      const runs = (await transaction.get<string[]>(runsKey)) ?? [];
      if (!runs.includes(runId)) await transaction.put(runsKey, [...runs, runId]);
    });
    if (this.#activateRun === undefined)
      throw new Error("The process-shard store fences are not installed.");
    await this.#activateRun(runId, fence);
    await this.assertCurrent();
  }

  storage() {
    const original = this.#storage;
    const transaction = this.transaction.bind(this);
    // Platform accessors and methods need their original receiver. Mutations share the fence read
    // and write transaction, so an old actor cannot write after a newer constructor advances it.
    return new Proxy(original, {
      get(target, key) {
        if (key === "transaction") return transaction;
        if (key === "put")
          return (keyOrValues: string | Record<string, unknown>, value?: unknown) =>
            transaction(async (write) => {
              if (typeof keyOrValues === "string") await write.put(keyOrValues, value);
              else await write.put(keyOrValues);
            });
        if (key === "delete")
          return (keys: string | string[]) =>
            typeof keys === "string"
              ? transaction((write) => write.delete(keys))
              : transaction((write) => write.delete(keys));
        if (key === "deleteAll")
          return () =>
            Promise.reject(new Error("A live process shard cannot erase its incarnation fence."));
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}

export function processContext(context: DurableObjectState, incarnation: ProcessIncarnation) {
  const storage = incarnation.storage();
  return new Proxy(context, {
    get(target, key) {
      if (key === "storage") return storage;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
