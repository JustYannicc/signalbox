import { AutomationSandbox } from "@signalbox/automations/host";
import * as Layer from "effect/Layer";

// The bundlers (wrangler's and Alchemy's) turn this `.wasm` import into a
// CompiledWasm module; `#quickjs/` maps to the QuickJS build in package.json.
import wasmModule from "#quickjs/emscripten-module.wasm";
import { makeCloudReplay } from "./sandbox.ts";

/** The cloud's automation sandbox: QuickJS from the Worker's wasm module, stopped by an interrupt-count budget. */
export const replayWorkflow = makeCloudReplay(wasmModule);

export const layerSandbox = Layer.succeed(
  AutomationSandbox,
  AutomationSandbox.of({ replay: replayWorkflow }),
);
