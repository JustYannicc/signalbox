import { WorkerEntrypoint } from "cloudflare:workers";
export * from "../src/FixtureWorkerExports.ts";
import type {
  HarnessProcessExecutionShardInput,
  HarnessProcessExecutionShardResult,
} from "../src/harness/HarnessProcessPlacement.ts";

interface ProcessExecutionEntrypoint {
  runShard(input: HarnessProcessExecutionShardInput): Promise<HarnessProcessExecutionShardResult>;
}

interface ProcessExecutionProbeEnvironment {
  readonly PROCESS_EXECUTION: ProcessExecutionEntrypoint;
  readonly PROCESS_EXECUTION_MISSING: ProcessExecutionEntrypoint;
  readonly PROCESS_EXECUTION_EMPTY: ProcessExecutionEntrypoint;
  readonly PROCESS_EXECUTION_INVALID: ProcessExecutionEntrypoint;
}

/** Test-only caller for the named entrypoint exported by the normal Cloud Worker. */
export default class ProcessExecutionDeploymentProbe extends WorkerEntrypoint<ProcessExecutionProbeEnvironment> {
  override async fetch(request: Request): Promise<Response> {
    const input = (await request.json()) as HarnessProcessExecutionShardInput;
    const execution = {
      "/run": this.env.PROCESS_EXECUTION,
      "/missing": this.env.PROCESS_EXECUTION_MISSING,
      "/empty": this.env.PROCESS_EXECUTION_EMPTY,
      "/invalid": this.env.PROCESS_EXECUTION_INVALID,
    }[new URL(request.url).pathname];
    if (!execution) return new Response("Unknown process-execution probe path.", { status: 404 });
    try {
      const result = await execution.runShard(input);
      return Response.json(result);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  }
}
