// @effect-diagnostics nodeBuiltinImport:off - native Proxy identification must not execute guest traps.
import * as NodeUtil from "node:util";
import { generatedCodePromise } from "../generated/generation-realm.ts";
import {
  nodeGeneratedFunctionSourceKey,
  type NodeGeneratedFunctionCode,
} from "../../NodeGeneratedCode.ts";
import type {
  NodeVmCodeOrigin,
  NodeVmInterpreter,
  NodeVmNativeFunction,
} from "./runtime-contract.ts";

const apply = Reflect.apply;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const hasOwn = Object.hasOwn;
const create = Object.create;
const freeze = Object.freeze;
const setPrototypeOf = Reflect.setPrototypeOf;
const getOwnPropertyNames = Object.getOwnPropertyNames;
const slice = Array.prototype.slice;
const arrayIterator = Array.prototype[Symbol.iterator];
const iteratorSymbol = Symbol.iterator;
const defineProperty = Object.defineProperty;
const promiseThen = Promise.prototype.then;
const NativeAggregateError = AggregateError;
const nodeGlobal = globalThis;
// workerd routes this export to v8::Value::IsProxy, including revoked proxies.
const nativeIsProxy =
  typeof NodeUtil.types?.isProxy === "function" ? NodeUtil.types.isProxy : undefined;
const capturedGlobalNames = ["require", "module", "exports", "__filename", "__dirname"];

/** Nimbus's precompiled CJS export. Factories must be loaded before guest execution. */
export interface NodeVmPreparedFunctionFactory {
  (dynamicImport: NodeVmCodeOrigin["import"], Function: unknown): NodeVmNativeFunction;
  readonly unbound?: (dynamicImport: NodeVmCodeOrigin["import"]) => NodeVmNativeFunction;
  readonly source?: string;
}

export interface NodeVmFunctionOptions {
  readonly learning?: {
    learnFunction(entry: NodeGeneratedFunctionCode): Promise<unknown>;
  };
  readonly prepared?: {
    readonly functionIndex: Readonly<Record<string, string>>;
    readonly modules: Readonly<Record<string, NodeVmPreparedFunctionFactory>>;
    /** `registerSource` from the same launch's prepared primordial module. */
    readonly registerSource: (fn: object, source: string) => void;
  };
}

/** Keeps persistence asynchronous without making constructors asynchronous or swallowing failures. */
export function createLearnedFunctions(
  interpreter: NodeVmInterpreter,
  options: NodeVmFunctionOptions,
  canStageFunction?: (
    kind: NodeGeneratedFunctionCode["kind"],
    params: readonly string[],
    body: string,
  ) => boolean,
) {
  const prepared = options.prepared;
  const factories = create(null) as Record<
    string,
    {
      readonly factory: NodeVmPreparedFunctionFactory;
      readonly unbound: NodeVmPreparedFunctionFactory["unbound"];
      readonly source: string | undefined;
    }
  >;
  if (prepared) {
    for (const identity of getOwnPropertyNames(prepared.functionIndex)) {
      const name = getOwnPropertyDescriptor(prepared.functionIndex, identity)?.value as unknown;
      if (typeof name !== "string") continue;
      const factory = getOwnPropertyDescriptor(prepared.modules, name)?.value as unknown;
      if (typeof factory !== "function") continue;
      const unbound = getOwnPropertyDescriptor(factory, "unbound")?.value as unknown;
      const source = getOwnPropertyDescriptor(factory, "source")?.value as unknown;
      factories[identity] = {
        factory: factory as NodeVmPreparedFunctionFactory,
        unbound:
          typeof unbound === "function"
            ? (unbound as NonNullable<NodeVmPreparedFunctionFactory["unbound"]>)
            : undefined,
        source: typeof source === "string" ? source : undefined,
      };
    }
  }
  const failures = learningQueue<unknown>();
  let pending = learningQueue<Promise<void>>();
  let flushing: Promise<void> | undefined;
  let draining = false;
  const recordFailure = (error: unknown) => {
    failures[failures.length] = error;
  };
  const compileFunction: NodeVmInterpreter["compileFunction"] = (kind, params, body, origin) => {
    const entry = stableEntry(kind, params, body);
    // Syntax/analysis failures still go through the interpreter's normal error path.
    let stageable = false;
    try {
      stageable = canStageFunction?.(kind, params, body) === true;
    } catch {}
    const staged = factories[nodeGeneratedFunctionSourceKey(entry)];
    if (stageable && staged && origin && stagedGlobalReadsAreSafe()) {
      const fn =
        origin.Function === undefined && staged.unbound !== undefined
          ? staged.unbound(origin.import)
          : staged.factory(origin.import, origin.Function);
      if (staged.source !== undefined) prepared!.registerSource(fn, staged.source);
      return fn;
    }
    const compiled = interpreter.compileFunction(kind, params, body, origin);
    if (stageable && options.learning) {
      try {
        const result = options.learning.learnFunction(entry);
        const observed = generatedCodePromise(
          apply(promiseThen, generatedCodePromise(result), [
            () => undefined,
            recordFailure,
          ]) as Promise<void>,
        );
        pending[pending.length] = observed;
      } catch (error) {
        recordFailure(error);
      }
    }
    return compiled;
  };
  const drain = () =>
    generatedCodePromise(
      (async () => {
        try {
          // Keep the batch visible to concurrent flushes and include compilations that arrive while awaiting.
          for (let index = 0; index < pending.length; index++) await pending[index];
          pending = learningQueue();
          if (failures.length > 0) {
            const errors = apply(slice, failures, []) as unknown[];
            defineProperty(errors, iteratorSymbol, { value: arrayIterator });
            failures.length = 0;
            throw new NativeAggregateError(errors, "Node vm generated-function persistence failed");
          }
        } finally {
          // Clear before settlement, including the synchronous empty-drain case.
          draining = false;
        }
      })(),
    );
  return {
    compileFunction,
    flushLearning(): Promise<void> {
      if (draining) return flushing!;
      draining = true;
      const result = drain();
      flushing = result;
      return result;
    },
  };
}

function stagedGlobalReadsAreSafe(): boolean {
  // The pinned factory reads all five globals even when the function never names them.
  // Recheck each construction because guest code can replace an own or inherited descriptor.
  try {
    if (!nativeIsProxy || nativeIsProxy(nodeGlobal)) return false;
    const globalBinding = getOwnPropertyDescriptor(nodeGlobal, "globalThis");
    if (!globalBinding || !hasOwn(globalBinding, "value") || globalBinding.value !== nodeGlobal)
      return false;
    for (let index = 0; index < capturedGlobalNames.length; index++) {
      let target: object | null = nodeGlobal;
      while (target !== null) {
        if (nativeIsProxy(target)) return false;
        const descriptor = getOwnPropertyDescriptor(target, capturedGlobalNames[index]!);
        if (descriptor !== undefined) {
          if (!hasOwn(descriptor, "value")) return false;
          break;
        }
        target = getPrototypeOf(target);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function stableEntry(
  kind: NodeGeneratedFunctionCode["kind"],
  params: readonly string[],
  body: string,
): NodeGeneratedFunctionCode {
  // A real array with no prototype avoids guest toJSON/iterator hooks in identity and persistence.
  const copied = [] as string[];
  setPrototypeOf(copied, null);
  for (let index = 0; index < params.length; index++) copied[index] = params[index]!;
  return freeze({ kind, params: freeze(copied), body });
}

function learningQueue<T>(): T[] {
  const queue: T[] = [];
  setPrototypeOf(queue, null);
  return queue;
}
