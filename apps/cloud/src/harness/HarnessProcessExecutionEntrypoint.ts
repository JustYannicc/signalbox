// @effect-diagnostics cryptoRandomUUID:off - request context IDs are opaque platform identifiers.
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  deterministicShardOwner,
  type HarnessProcessExecutionShardResult,
  type HarnessProcessExecutionEnvironment,
  type HarnessProcessExecutionShardInput,
} from "./processPlacement/execution.ts";
import { WORKER_REQUEST_INVOCATION_LIMIT } from "./processPlacement/limits.ts";

export interface HarnessProcessExecutionEntrypointEnvironment extends HarnessProcessExecutionEnvironment {
  readonly PROCESS_EXECUTION_SHARDS: DurableObjectNamespace;
}

interface HarnessProcessExecutionShardClient {
  runShard(
    input: HarnessProcessExecutionShardInput,
    requestContextId: string,
  ): Promise<HarnessProcessExecutionShardResult>;
}

interface HarnessProcessExecutionExports {
  readonly HarnessProcessExecutionEntrypoint: (options: {
    readonly props: Record<string, never>;
  }) => {
    runShard(input: HarnessProcessExecutionShardInput): Promise<HarnessProcessExecutionShardResult>;
  };
}

export class HarnessProcessExecutionEntrypoint extends WorkerEntrypoint<HarnessProcessExecutionEntrypointEnvironment> {
  async runShard(
    input: HarnessProcessExecutionShardInput,
  ): Promise<HarnessProcessExecutionShardResult> {
    const firstIndex = input.shardIndex ?? 0;
    const batches = [];
    for (let start = 0; start < input.processes.length; start += WORKER_REQUEST_INVOCATION_LIMIT) {
      batches.push({
        shardIndex: firstIndex + batches.length,
        processes: input.processes.slice(start, start + WORKER_REQUEST_INVOCATION_LIMIT),
      });
    }
    if (batches.length === 0) return { requestContextId: crypto.randomUUID(), processes: [] };

    const results = await Promise.all(
      batches.map(({ shardIndex, processes }, index) => {
        const shard = { ...input, shardIndex, processes };
        return index === 0 ? this.#route(shard) : this.#overflow(shard);
      }),
    );
    return {
      requestContextId: results[0]!.requestContextId,
      processes: results.flatMap((result) => result.processes),
    };
  }

  async #route(
    input: HarnessProcessExecutionShardInput,
  ): Promise<HarnessProcessExecutionShardResult> {
    const owner = await deterministicShardOwner(
      input.shardOwner,
      input.executionOperationId,
      input.shardIndex ?? 0,
    );
    const shard = this.env.PROCESS_EXECUTION_SHARDS.getByName(
      owner,
    ) as unknown as HarnessProcessExecutionShardClient;
    return await shard.runShard(input, crypto.randomUUID());
  }

  #overflow(input: HarnessProcessExecutionShardInput): Promise<HarnessProcessExecutionShardResult> {
    const exports = (this.ctx as unknown as { readonly exports: HarnessProcessExecutionExports })
      .exports;
    return exports.HarnessProcessExecutionEntrypoint({ props: {} }).runShard(input);
  }
}
