/** The exact RuntimeFunctionKind keys exported by Nimbus's runtime function source. */
export type NodeVmRuntimeFunctionKind = "function" | "async" | "generator" | "asyncGenerator";

/** The NativeFunction type exported by Nimbus's host-ops module. */
export type NodeVmNativeFunction = (this: unknown, ...args: unknown[]) => unknown;

/** The subset of ModuleHelpers from Nimbus's interpreter/modules.ts. */
export interface NodeVmModuleHelpers {
  readonly exports: NodeVmNativeFunction;
  readonly star: NodeVmNativeFunction;
  readonly conflicts: NodeVmNativeFunction;
  readonly load: NodeVmNativeFunction;
}

/** The subset of InterpreterHost supplied by the VM adapter. */
export interface NodeVmInterpreterHost {
  dynamicImport(
    parentUrl: string | undefined,
    specifier: unknown,
    options: unknown,
  ): Promise<unknown>;
  readonly primordials: object;
  readonly moduleHelpers: NodeVmModuleHelpers;
}

/** Exact CodeOrigin signature exported by Nimbus's interpreter/index.ts. */
export interface NodeVmCodeOrigin {
  import(specifier: unknown, options: unknown): Promise<unknown>;
  readonly Function: unknown;
}

/** Only the upstream HostOps value is forwarded to createInterpreter; the adapter never inspects it. */
export type NodeVmHostOps = object;

/** The NativeFunction result and methods called by the Node vm adapter. */
export interface NodeVmInterpreter {
  compileFunction(
    kind: NodeVmRuntimeFunctionKind,
    params: readonly string[],
    body: string,
    origin?: NodeVmCodeOrigin,
  ): NodeVmNativeFunction;
  compileExpression(code: string, origin?: NodeVmCodeOrigin): NodeVmNativeFunction;
}
