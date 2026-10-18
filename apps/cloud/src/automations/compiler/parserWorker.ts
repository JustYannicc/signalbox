import { WorkerEntrypoint } from "cloudflare:workers";
import { createParser } from "@signalbox/automation-compiler/workerdParser";
import { prepareWorkflow } from "@signalbox/automation-compiler/prepareWorkflow";
import wasm from "./oxc.wasm";

const parser = await createParser(wasm);

export class Parser extends WorkerEntrypoint {
  prepare(source: string) {
    return prepareWorkflow(source, parser.parse);
  }

  memoryBytes() {
    return parser.memoryBytes();
  }
}
