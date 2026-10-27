import type { ProductWorkerEnv } from "./productBindings.workerd.fixture.ts";

/** The measured release stays byte-identical; only this synthetic peer may execute. */
export function memoryNativeModule(env: ProductWorkerEnv) {
  if (env.PRODUCT_MEMORY_NATIVE_WASM === undefined)
    throw new Error("The memory proof requires its synthetic native peer.");
  const bytes = Uint8Array.from(atob(env.PRODUCT_MEMORY_NATIVE_WASM), (value) =>
    value.charCodeAt(0),
  );
  if (bytes.byteLength >= 64 * 1024)
    throw new Error("The memory proof native peer exceeds its fixture-only size bound.");
  return { "codex-fixture-engine.wasm": { wasm: bytes.buffer } };
}
