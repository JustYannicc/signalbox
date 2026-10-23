import { WorkerEntrypoint } from "cloudflare:workers";
import {
  runHarnessProcessShard,
  type HarnessProcessExecutionEnvironment,
  type HarnessProcessExecutionShardInput,
  type HarnessProcessExecutionShardResult,
} from "./processPlacement/execution.ts";

interface ProcessPlacementExports {
  readonly HarnessProcessExecutionEntrypoint: (options: {
    readonly props: Record<string, never>;
  }) => {
    runShard(input: HarnessProcessExecutionShardInput): Promise<HarnessProcessExecutionShardResult>;
  };
}

export class HarnessProcessExecutionEntrypoint extends WorkerEntrypoint<HarnessProcessExecutionEnvironment> {
  runShard(input: HarnessProcessExecutionShardInput): Promise<HarnessProcessExecutionShardResult> {
    const exports = (this.ctx as unknown as { readonly exports: ProcessPlacementExports }).exports;
    return runHarnessProcessShard(input, this.ctx, this.env, (overflow) =>
      exports.HarnessProcessExecutionEntrypoint({ props: {} }).runShard(overflow),
    );
  }
}
