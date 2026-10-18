// oxlint-disable-next-line typescript/triple-slash-reference -- Carry OXC helper types to consumers without a runtime import.
/// <reference path="./oxcHelpers.d.ts" />
import { createInstance } from "@oxc-parser/binding-wasm32-wasip1/workerd";
import { wrap } from "oxc-parser/src-js/wrap";
import type { parseSync } from "oxc-parser";

/** A parser isolate owns only this memory. Loading the transformer here would exceed 128 MiB. */
export async function createParser(wasm: WebAssembly.Module) {
  const instance = await createInstance(wasm, {
    initialMemoryPages: 981,
    maximumMemoryPages: 1024,
  });
  return {
    // /workerd exposes the raw binding; the Node API applies this same exported wrapper.
    parse: ((...args) => wrap(instance.exports.parseSync(...args))) satisfies typeof parseSync,
    memoryBytes: () => instance.memoryBytes,
  };
}
