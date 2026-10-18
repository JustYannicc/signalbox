import { createInstance } from "@oxc-transform/binding-wasm32-wasip1/workerd";
import type { WorkflowTransform } from "./workflowPhases.ts";

/** Kept in its own isolate: OXC dispose does not release its WebAssembly.Memory closure. */
export async function createTransformer(wasm: WebAssembly.Module) {
  const instance = await createInstance(wasm, {
    initialMemoryPages: 981,
    maximumMemoryPages: 1024,
  });
  return {
    transform: ((...args) => instance.exports.transformSync(...args)) satisfies WorkflowTransform,
    memoryBytes: () => instance.memoryBytes,
  };
}
