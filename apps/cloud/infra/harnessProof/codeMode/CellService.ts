import { WorkerEntrypoint } from "cloudflare:workers";
import {
  createCodeModeWorkerLoader,
  type CodeModeCellEvents,
  type CodeModeCellInvocation,
} from "../../../src/harness/CodeModeHost.ts";

/** Deploy with a named CODE_MODE_CELLS service binding in the caller and LOADER here. */
export class CodeModeCellService extends WorkerEntrypoint<{
  LOADER: WorkerLoader;
  CODE_MODE_CPU_MS: string;
}> {
  async run(input: CodeModeCellInvocation, events: CodeModeCellEvents) {
    const loader = createCodeModeWorkerLoader({
      loader: this.env.LOADER,
      policy: { cpuMs: Number(this.env.CODE_MODE_CPU_MS) },
    });
    return loader.run(input, events);
  }
}
