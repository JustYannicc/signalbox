import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  HarnessProcessExecutionShardInput,
  HarnessProcessExecutionShardResult,
} from "../src/harness/HarnessProcessPlacement.ts";

interface ProcessExecutionEntrypoint {
  runShard(input: HarnessProcessExecutionShardInput): Promise<HarnessProcessExecutionShardResult>;
}

interface ProcessExecutionProbeEnvironment {
  readonly PROCESS_EXECUTION: ProcessExecutionEntrypoint;
}

/** Test-only caller for the named entrypoint exported by the normal Cloud Worker. */
export default class ProcessExecutionDeploymentProbe extends WorkerEntrypoint<ProcessExecutionProbeEnvironment> {
  override async fetch(request: Request): Promise<Response> {
    const input = (await request.json()) as HarnessProcessExecutionShardInput;
    const result = await this.env.PROCESS_EXECUTION.runShard(input);
    return Response.json(result);
  }
}
