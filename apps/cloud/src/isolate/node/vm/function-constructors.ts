import type { NodeVmInterpreter, NodeVmRuntimeFunctionKind } from "./runtime-contract.ts";
import { nativeCodeGenerationRefused } from "./codegen-refusal.ts";
import { vmOrigin } from "./code-origin.ts";

// Guest code can replace these operations after launch.
const apply = Reflect.apply;
const construct = Reflect.construct;
const get = Reflect.get;
const setPrototypeOf = Reflect.setPrototypeOf;
const getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const defineProperty = Object.defineProperty;
const createObject = Object.create;
const NativeArray = Array;
const stringOf = String;
const NativeError = Error;
const NativeTypeError = TypeError;
const NativeFunction = Function;

const NativeAsyncFunction = getPrototypeOf(async function () {}).constructor as Function;
const NativeGeneratorFunction = getPrototypeOf(function* () {}).constructor as Function;
const NativeAsyncGeneratorFunction = getPrototypeOf(async function* () {}).constructor as Function;

export interface NodeVmFunctionConstructor {
  (...args: string[]): Function;
  new (...args: string[]): Function;
  readonly prototype: object;
  readonly name: string;
  readonly length: number;
  toString(): string;
}

export interface NodeVmNativeFunctionConstructors {
  readonly Function: NodeVmFunctionConstructor;
  readonly AsyncFunction: NodeVmFunctionConstructor;
  readonly GeneratorFunction: NodeVmFunctionConstructor;
  readonly AsyncGeneratorFunction: NodeVmFunctionConstructor;
}

export interface NodeVmFunctionConstructorShims extends NodeVmNativeFunctionConstructors {
  /** The bootstrap owner calls this once, before loading guest code. */
  install(): NodeVmFunctionConstructorInstallation;
}

export interface NodeVmFunctionConstructorInstallation {
  restore(): void;
}

export class NodeVmFunctionInstallError extends NativeError {
  readonly code: string;

  constructor(message: string, code = "ERR_NODE_VM_FUNCTION_INSTALL") {
    super(message);
    this.name = "NodeVmFunctionInstallError";
    this.code = code;
  }
}

export function createNodeVmFunctionConstructorShims(
  interpreter: Pick<NodeVmInterpreter, "compileFunction">,
  nativeConstructors: NodeVmNativeFunctionConstructors = {
    Function: NativeFunction as unknown as NodeVmFunctionConstructor,
    AsyncFunction: NativeAsyncFunction as unknown as NodeVmFunctionConstructor,
    GeneratorFunction: NativeGeneratorFunction as unknown as NodeVmFunctionConstructor,
    AsyncGeneratorFunction: NativeAsyncGeneratorFunction as unknown as NodeVmFunctionConstructor,
  },
): NodeVmFunctionConstructorShims {
  const FunctionShim = routedConstructor("function", nativeConstructors.Function, interpreter);
  const AsyncFunctionShim = routedConstructor(
    "async",
    nativeConstructors.AsyncFunction,
    interpreter,
    FunctionShim,
  );
  const GeneratorFunctionShim = routedConstructor(
    "generator",
    nativeConstructors.GeneratorFunction,
    interpreter,
    FunctionShim,
  );
  const AsyncGeneratorFunctionShim = routedConstructor(
    "asyncGenerator",
    nativeConstructors.AsyncGeneratorFunction,
    interpreter,
    FunctionShim,
  );

  return Object.freeze({
    Function: FunctionShim,
    AsyncFunction: AsyncFunctionShim,
    GeneratorFunction: GeneratorFunctionShim,
    AsyncGeneratorFunction: AsyncGeneratorFunctionShim,
    install: () =>
      installFunctionConstructors(nativeConstructors, {
        Function: FunctionShim,
        AsyncFunction: AsyncFunctionShim,
        GeneratorFunction: GeneratorFunctionShim,
        AsyncGeneratorFunction: AsyncGeneratorFunctionShim,
      }),
  });
}

function routedConstructor(
  kind: NodeVmRuntimeFunctionKind,
  native: NodeVmFunctionConstructor,
  interpreter: Pick<NodeVmInterpreter, "compileFunction">,
  parent: object | null = getPrototypeOf(native),
): NodeVmFunctionConstructor {
  const nativeToString = get(native, "toString");
  const routed = function (...args: unknown[]) {
    const target = new.target;
    const sourceArgs = stringifyFunctionArguments(args);
    // V8 can admit an empty constructor even when string compilation is disabled.
    if (!nativeCodeGenerationRefused(() => apply(native, undefined, ["return 0"]))) {
      return target === undefined
        ? apply(native, undefined, sourceArgs)
        : construct(native, sourceArgs, target);
    }
    const paramCount = sourceArgs.length === 0 ? 0 : sourceArgs.length - 1;
    const params = new NativeArray<string>(paramCount);
    setPrototypeOf(params, null);
    for (let i = 0; i < params.length; i++) params[i] = sourceArgs[i]!;
    const body = sourceArgs.length === 0 ? "" : sourceArgs[sourceArgs.length - 1]!;
    const compiled = interpreter.compileFunction(kind, params, body, vmOrigin);
    if (target !== undefined && target !== routed) {
      const prototype = get(target, "prototype");
      if (isObjectOrFunction(prototype)) setPrototypeOf(compiled, prototype);
    }
    return compiled;
  };

  defineProperty(routed, "name", { value: get(native, "name"), configurable: true });
  defineProperty(routed, "length", { value: get(native, "length"), configurable: true });
  defineProperty(routed, "prototype", { value: get(native, "prototype"), writable: false });
  defineProperty(routed, "toString", {
    value: () => apply(nativeToString as Function, native, []),
    configurable: true,
    writable: true,
  });
  setPrototypeOf(routed, parent);
  return routed as unknown as NodeVmFunctionConstructor;
}

function stringifyFunctionArguments(args: readonly unknown[]): string[] {
  const strings = new NativeArray<string>(args.length);
  setPrototypeOf(strings, null);
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (typeof value === "symbol") {
      throw new NativeTypeError("Cannot convert a Symbol value to a string");
    }
    strings[i] = stringOf(value);
  }
  return strings;
}

function installFunctionConstructors(
  native: NodeVmNativeFunctionConstructors,
  routed: NodeVmNativeFunctionConstructors,
): NodeVmFunctionConstructorInstallation {
  const globalDescriptor = getOwnPropertyDescriptor(globalThis, "Function");
  if (!globalDescriptor || globalDescriptor.value !== native.Function) {
    throw new NodeVmFunctionInstallError(
      "The global Function constructor changed before installation",
    );
  }

  const prototypePairs = [
    [get(native.Function, "prototype"), routed.Function],
    [get(native.AsyncFunction, "prototype"), routed.AsyncFunction],
    [get(native.GeneratorFunction, "prototype"), routed.GeneratorFunction],
    [get(native.AsyncGeneratorFunction, "prototype"), routed.AsyncGeneratorFunction],
  ] as const;
  const previous: { target: object; key: PropertyKey; descriptor: PropertyDescriptor }[] = [];
  const installed: { target: object; key: PropertyKey; descriptor: PropertyDescriptor }[] = [];
  const uniquePairs: (typeof prototypePairs)[number][] = [];
  const seen = new Set<object>();
  for (const [target, constructor] of prototypePairs) {
    if (!isObjectOrFunction(target)) {
      throw new NodeVmFunctionInstallError("A native Function constructor has no prototype object");
    }
    if (!seen.has(target)) {
      seen.add(target);
      uniquePairs.push([target, constructor]);
    }
  }

  try {
    for (const [target, constructor] of uniquePairs) {
      const descriptor = getOwnPropertyDescriptor(target, "constructor");
      if (!descriptor || descriptor.value !== nativeConstructorFor(target, native)) {
        throw new NodeVmFunctionInstallError(
          "A native Function prototype changed before installation",
        );
      }
      previous.push({ target, key: "constructor", descriptor: copyDescriptor(descriptor) });
      const next = copyDescriptor(descriptor);
      next.value = constructor;
      defineProperty(target, "constructor", next);
      installed.push({ target, key: "constructor", descriptor: next });
    }

    const nextGlobal = copyDescriptor(globalDescriptor);
    nextGlobal.value = routed.Function;
    defineProperty(globalThis, "Function", nextGlobal);
    previous.push({
      target: globalThis,
      key: "Function",
      descriptor: copyDescriptor(globalDescriptor),
    });
    installed.push({ target: globalThis, key: "Function", descriptor: nextGlobal });
  } catch (error) {
    restoreDescriptors(previous);
    throw error;
  }

  let restored = false;
  return {
    restore() {
      if (restored) return;
      for (const entry of installed) {
        if (!sameDescriptor(getOwnPropertyDescriptor(entry.target, entry.key), entry.descriptor)) {
          throw new NodeVmFunctionInstallError(
            "Function constructor installation ownership changed",
            "ERR_NODE_VM_FUNCTION_OWNERSHIP_LOST",
          );
        }
      }
      restoreDescriptors(previous);
      restored = true;
    },
  };
}

function nativeConstructorFor(
  prototype: object,
  native: NodeVmNativeFunctionConstructors,
): Function | undefined {
  if (prototype === get(native.Function, "prototype")) return native.Function;
  if (prototype === get(native.AsyncFunction, "prototype")) return native.AsyncFunction;
  if (prototype === get(native.GeneratorFunction, "prototype")) return native.GeneratorFunction;
  if (prototype === get(native.AsyncGeneratorFunction, "prototype"))
    return native.AsyncGeneratorFunction;
  return undefined;
}

function restoreDescriptors(
  entries: readonly { target: object; key: PropertyKey; descriptor: PropertyDescriptor }[],
): void {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    defineProperty(entry.target, entry.key, copyDescriptor(entry.descriptor));
  }
}

function copyDescriptor(descriptor: PropertyDescriptor): PropertyDescriptor {
  const copy = createObject(null) as PropertyDescriptor;
  if ("value" in descriptor) copy.value = descriptor.value;
  if ("writable" in descriptor) copy.writable = descriptor.writable;
  if ("get" in descriptor) copy.get = descriptor.get;
  if ("set" in descriptor) copy.set = descriptor.set;
  if ("enumerable" in descriptor) copy.enumerable = descriptor.enumerable;
  if ("configurable" in descriptor) copy.configurable = descriptor.configurable;
  return copy;
}

function sameDescriptor(
  actual: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
): boolean {
  if (!actual) return false;
  return (
    actual.value === expected.value &&
    actual.writable === expected.writable &&
    actual.get === expected.get &&
    actual.set === expected.set &&
    actual.enumerable === expected.enumerable &&
    actual.configurable === expected.configurable
  );
}

function isObjectOrFunction(value: unknown): value is object | Function {
  return value !== null && (typeof value === "object" || typeof value === "function");
}
