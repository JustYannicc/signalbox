import type {
  NodeVmHostOps,
  NodeVmInterpreter,
  NodeVmInterpreterHost,
  NodeVmModuleHelpers,
} from "./node/vm/runtime-contract.ts";
import { isCodegenRefusal } from "./node/vm/codegen-refusal.ts";
import { rejectedDynamicImport, vmOrigin } from "./node/vm/code-origin.ts";
import {
  createNodeVmFunctionConstructorShims,
  type NodeVmFunctionConstructorShims,
  type NodeVmNativeFunctionConstructors,
} from "./node/vm/function-constructors.ts";

export { NodeVmFunctionInstallError } from "./node/vm/function-constructors.ts";
export type {
  NodeVmFunctionConstructor,
  NodeVmFunctionConstructorInstallation,
  NodeVmFunctionConstructorShims,
  NodeVmNativeFunctionConstructors,
} from "./node/vm/function-constructors.ts";

// Capture before guest code can replace the operations used by fallback execution.
const NativeTypeError = TypeError;
const apply = Reflect.apply;
const getPrototypeOf = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const setPrototypeOf = Reflect.setPrototypeOf;
const NativeArray = Array;
const arrayIsArray = Array.isArray;
const stringOf = String;
const objectPrototype = Object.prototype;
const nodeGlobal = globalThis;

export class NodeVmUnsupportedOptionError extends NativeTypeError {
  readonly code = "ERR_NODE_VM_UNSUPPORTED_OPTION";
  readonly method: "runInThisContext" | "compileFunction";
  readonly option: string;

  constructor(method: "runInThisContext" | "compileFunction", option: string) {
    super(`vm.${method} cannot honor fallback option "${option}"`);
    this.method = method;
    this.option = option;
    this.name = "NodeVmUnsupportedOptionError";
  }
}

/** Load the primordial module before guest code; all prepared modules share its `LAUNCH_PRIMORDIALS`. */
export interface NodeVmRuntimeModules {
  /** `createInterpreter` from `node/vm/interpreter.js`. */
  readonly createInterpreter: (
    hostOps: NodeVmHostOps,
    host: NodeVmInterpreterHost,
  ) => NodeVmInterpreter;
  /** The value exported by the sloppy CJS `node/vm/host-ops.js` module. */
  readonly hostOps: NodeVmHostOps;
  /** `LAUNCH_PRIMORDIALS` from `node/vm/interpreter-primordials.js`. */
  readonly primordials: object;
  /** The CJS `node/vm/module-helpers.js` export generated from `ESM_MODULE_HELPERS`. */
  readonly moduleHelpers: NodeVmModuleHelpers;
}

export type NodeVmNativeSurface = {
  readonly runInThisContext: Function;
  readonly compileFunction: Function;
};

export type NodeVmModule<T extends NodeVmNativeSurface> = Omit<
  T,
  "runInThisContext" | "compileFunction"
> & {
  runInThisContext(code: string, options?: string | object): unknown;
  compileFunction(code: string, params?: readonly string[], options?: object): Function;
};

export interface NodeVm<T extends NodeVmNativeSurface> {
  readonly module: NodeVmModule<T>;
  readonly functionConstructors: NodeVmFunctionConstructorShims;
}

/**
 * Wraps native vm first. Only Workerd's code-generation refusal falls back,
 * and that fallback is synchronous and local to this Worker.
 */
export function createNodeVm<T extends NodeVmNativeSurface>(
  nativeVm: T,
  modules: NodeVmRuntimeModules,
  nativeConstructors?: NodeVmNativeFunctionConstructors,
): NodeVm<T> {
  const interpreter = modules.createInterpreter(modules.hostOps, {
    dynamicImport: () => rejectedDynamicImport(),
    primordials: modules.primordials,
    moduleHelpers: modules.moduleHelpers,
  });

  const nativeRunInThisContext = nativeVm.runInThisContext;
  const nativeCompileFunction = nativeVm.compileFunction;
  const runInThisContext = (code: string, options?: string | object): unknown => {
    try {
      return apply(nativeRunInThisContext, nativeVm, [code, options]);
    } catch (error) {
      if (!isCodegenRefusal(error)) throw error;
      assertNoFallbackOptions("runInThisContext", options);
      const compiled = interpreter.compileExpression(stringOf(code), vmOrigin);
      return apply(compiled, nodeGlobal, []);
    }
  };
  const compileFunction = (
    code: string,
    params?: readonly string[],
    options?: object,
  ): Function => {
    try {
      return apply(nativeCompileFunction, nativeVm, [code, params, options]) as Function;
    } catch (error) {
      if (!isCodegenRefusal(error)) throw error;
      assertNoFallbackOptions("compileFunction", options);
      return interpreter.compileFunction(
        "function",
        normalizeParameters(params),
        stringOf(code),
        vmOrigin,
      );
    }
  };
  const module = Object.freeze({
    ...nativeVm,
    runInThisContext,
    compileFunction,
  }) as NodeVmModule<T>;

  return Object.freeze({
    module,
    functionConstructors: createNodeVmFunctionConstructorShims(interpreter, nativeConstructors),
  });
}

function assertNoFallbackOptions(
  method: "runInThisContext" | "compileFunction",
  options: unknown,
): void {
  if (options === undefined) return;
  if (typeof options === "string") throw new NodeVmUnsupportedOptionError(method, "filename");
  if (options === null || (typeof options !== "object" && typeof options !== "function")) {
    throw new NativeTypeError(`vm.${method} options must be an object`);
  }
  const prototype = getPrototypeOf(options);
  if (prototype !== objectPrototype && prototype !== null) {
    throw new NodeVmUnsupportedOptionError(method, "options prototype");
  }
  const keys = ownKeys(options);
  if (keys.length > 0) {
    const first = keys[0]!;
    throw new NodeVmUnsupportedOptionError(
      method,
      typeof first === "string" ? first : "symbol option",
    );
  }
}

function normalizeParameters(params: readonly string[] | undefined): string[] {
  if (params === undefined) return [];
  if (!arrayIsArray(params))
    throw new NativeTypeError("vm.compileFunction params must be an array");
  const names = new NativeArray<string>(params.length);
  setPrototypeOf(names, null);
  for (let i = 0; i < params.length; i++) names[i] = stringOf(params[i]);
  return names;
}

