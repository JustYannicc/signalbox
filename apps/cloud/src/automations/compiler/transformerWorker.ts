import { WorkerEntrypoint } from "cloudflare:workers";
import { createTransformer } from "@signalbox/automation-compiler/workerdTransformer";
import { finishWorkflow } from "@signalbox/automation-compiler/finishWorkflow";
import { forCloud } from "@signalbox/automation-compiler/forCloud";
import type { WorkflowPlan } from "@signalbox/automation-compiler/workflowPhases";
import wasm from "./oxc.wasm";

const transformer = await createTransformer(wasm);

export class Transformer extends WorkerEntrypoint {
  finish(plan: WorkflowPlan) {
    return forCloud(finishWorkflow(plan, transformer.transform));
  }

  memoryBytes() {
    return transformer.memoryBytes();
  }
}
