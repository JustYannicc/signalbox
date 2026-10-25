import { DurableObject } from "cloudflare:workers";
import type {
  HarnessProcessExecutionHooks,
  HarnessProcessExecutionEnvironment,
  HarnessProcessExecutionShardInput,
} from "./processPlacement/execution.ts";
import { runHarnessProcessExecutionShard } from "./processPlacement/execution.ts";
import type { HarnessProcessExecutionShardResult } from "./processPlacement/execution.ts";
import { DURABLE_OBJECT_INVOCATION_LIMIT } from "./processPlacement/limits.ts";

interface HarnessProcessExecutionShardExports {
  readonly HarnessProcessExecutionEntrypoint: (options: {
    readonly props: Record<string, never>;
  }) => {
    runShard(input: HarnessProcessExecutionShardInput): Promise<HarnessProcessExecutionShardResult>;
  };
}

/** The DO I/O context owns the durable keyed Dynamic Worker facets it starts. */
export class HarnessProcessExecutionShardObject extends DurableObject<HarnessProcessExecutionEnvironment> {
  #active = false;
  // @effect-diagnostics-next-line cryptoRandomUUID:off - immutable identity for this DO construction.
  readonly #executionIncarnationNonce = crypto.randomUUID();

  executionIncarnationNonce() {
    return this.#executionIncarnationNonce;
  }

  protected processExecutionHooks(): HarnessProcessExecutionHooks | undefined {
    return undefined;
  }

  async runShard(
    input: HarnessProcessExecutionShardInput,
    requestContextId: string,
  ): Promise<HarnessProcessExecutionShardResult> {
    if (this.#active) throw new Error("This process shard already has an active writer.");
    this.#active = true;
    try {
      const firstIndex = input.shardIndex ?? 0;
      const batches = [];
      for (
        let start = 0;
        start < input.processes.length;
        start += DURABLE_OBJECT_INVOCATION_LIMIT
      ) {
        batches.push({
          shardIndex: firstIndex + batches.length,
          processes: input.processes.slice(start, start + DURABLE_OBJECT_INVOCATION_LIMIT),
        });
      }
      if (batches.length === 0) return { requestContextId, processes: [] };

      const results = await Promise.all(
        batches.map(({ shardIndex, processes }, index) => {
          const shard = { ...input, shardIndex, processes };
          return index === 0
            ? runHarnessProcessExecutionShard(
                shard,
                requestContextId,
                this.ctx,
                this.env,
                this.#executionIncarnationNonce,
                this.processExecutionHooks(),
              )
            : this.#overflow(shard);
        }),
      );
      return {
        requestContextId: results[0]!.requestContextId,
        processes: results.flatMap((result) => result.processes),
      };
    } finally {
      this.#active = false;
    }
  }

  #overflow(input: HarnessProcessExecutionShardInput): Promise<HarnessProcessExecutionShardResult> {
    const exports = (
      this.ctx as unknown as { readonly exports: HarnessProcessExecutionShardExports }
    ).exports;
    // Give each DO branch its own prefix before the Worker entrypoint allocates nested indices.
    return exports.HarnessProcessExecutionEntrypoint({ props: {} }).runShard({
      ...input,
      shardOwner: `${input.shardOwner}/do-overflow-${input.shardIndex ?? 0}`,
      shardIndex: 0,
    });
  }
}
