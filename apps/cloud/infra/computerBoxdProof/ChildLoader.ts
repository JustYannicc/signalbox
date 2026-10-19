import {
  createCompiledChildWorkerLoader,
  type CompiledChildWorkerRegistry,
} from "../../src/computer/CompiledChildWorkerLoader.ts";
import type { ChildWorkerLoaderPort } from "../../src/computer/WorkerLoaderDispatch.ts";
import { CHILD_PROGRAM_WASM_REGISTRY } from "./programWasmRegistry.ts";

/** The proof build imports pinned compiled WASM into this native loader owner. */
export function createProofChildLoader(
  loader: WorkerLoader,
  registry: CompiledChildWorkerRegistry = CHILD_PROGRAM_WASM_REGISTRY,
): ChildWorkerLoaderPort {
  return createCompiledChildWorkerLoader(loader, registry);
}
