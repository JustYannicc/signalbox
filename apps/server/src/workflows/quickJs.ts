import { makeQuickJsReplay, wallClockBudget } from "@signalbox/automations/sandbox/replayWorkflow";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";

/** The server's automation sandbox: QuickJS from its wasm file, stopped by the wall clock. */
export const replayWorkflow = makeQuickJsReplay({
  load: () => newQuickJSWASMModuleFromVariant(import("@jitl/quickjs-wasmfile-release-sync")),
  budget: wallClockBudget,
});
