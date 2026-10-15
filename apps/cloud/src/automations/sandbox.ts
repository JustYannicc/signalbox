import wasmfile from "@jitl/quickjs-wasmfile-release-sync";
import { makeQuickJsReplay } from "@signalbox/automations/sandbox/replayWorkflow";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSSyncVariant,
} from "quickjs-emscripten-core";

/**
 * QuickJS interrupt calls per millisecond of the budget. workerd's clock
 * stands still while code runs synchronously, so a wall-clock deadline never
 * passes; the cloud counts QuickJS's interrupt calls instead. QuickJS calls
 * the handler once per 10k loop iterations and function calls, so the rate
 * depends on the code: measured with QuickJS 0.32 (Node and workerd agree),
 * `while (true) {}` makes 30-80 calls a millisecond, `while (true) n++` about
 * 11, a function call per pass about 8, allocating objects about 2, and
 * JSON-heavy code well under 1. At 5, the 5 s default is 25k calls: about 2 s
 * of a tight loop, 3 s of calls, 15 s of allocation. Builtin-heavy code runs
 * longer; the Worker's CPU limit is its backstop.
 */
const INTERRUPT_CALLS_PER_MS = 5;

/** A budget of `timeLimitMs` worth of interrupt calls; true once it's spent. */
const interruptBudget = (timeLimitMs: number) => {
  const limit = Math.max(1, Math.round(timeLimitMs * INTERRUPT_CALLS_PER_MS));
  let calls = 0;
  return () => ++calls > limit;
};

/**
 * The cloud's automation sandbox around a precompiled QuickJS wasm module:
 * workerd can't compile wasm from bytes at runtime, so the Worker imports it
 * as a module (`quickJs.ts`) and tests compile the same file in Node.
 */
export const makeCloudReplay = (wasmModule: WebAssembly.Module) =>
  makeQuickJsReplay({
    load: () => newQuickJSWASMModuleFromVariant(newVariant(syncVariant(wasmfile), { wasmModule })),
    budget: interruptBudget,
  });

/**
 * The package types its ESM entry as CommonJS, so TypeScript sees the variant
 * one `default` deeper than it is. Node and both bundlers load the ESM entry,
 * where the `.default` branch never runs; it's there for the types.
 */
function syncVariant(module: QuickJSSyncVariant | { readonly default: QuickJSSyncVariant }) {
  return "type" in module ? module : module.default;
}
