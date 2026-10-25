import type { NodeVmCodeOrigin } from "./runtime-contract.ts";

// Guest code can replace Promise.reject and Reflect.apply after launch.
const NativeTypeError = TypeError;
const NativePromise = Promise;
const promiseReject = Promise.reject;
const apply = Reflect.apply;

class NodeVmDynamicImportError extends NativeTypeError {
  readonly code = "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING";

  constructor() {
    super("A dynamic import callback was not specified");
    this.name = "NodeVmDynamicImportError";
  }
}

export function rejectedDynamicImport(): Promise<never> {
  return apply(promiseReject, NativePromise, [new NodeVmDynamicImportError()]) as Promise<never>;
}

export const vmOrigin: NodeVmCodeOrigin = Object.freeze({
  import: (_specifier: unknown, _options: unknown) => rejectedDynamicImport(),
  Function: undefined,
});
