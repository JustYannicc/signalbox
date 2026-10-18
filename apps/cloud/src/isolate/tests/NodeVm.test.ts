/* eslint-disable no-extend-native -- Guest prototype mutations exercise interpreter compatibility. */
// @effect-diagnostics nodeBuiltinImport:off - loads prepared VM modules through Node in a disposable directory.
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  createNodeVm,
  type NodeVmFunctionConstructor,
  type NodeVmNativeFunctionConstructors,
  type NodeVmNativeSurface,
  type NodeVmRuntimeModules,
} from "../NodeVm.ts";
import {
  NODE_VM_PREPARED_MODULES,
  prepareNodeVmModules,
} from "../../../infra/nodeProof/prepareVm.ts";

const originalFunctionToString = Object.getOwnPropertyDescriptor(Function.prototype, "toString");
let preparedDirectory: string;
let runtimeModules: NodeVmRuntimeModules;
let fallback: ReturnType<typeof createNodeVm<NodeVmNativeSurface>>;

beforeAll(async () => {
  preparedDirectory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "signalbox-node-vm-"));
  await prepareNodeVmModules(preparedDirectory);

  const preparedRequire = NodeModule.createRequire(NodePath.join(preparedDirectory, "load.cjs"));
  const load = (name: string) =>
    preparedRequire(NodePath.join(preparedDirectory, name)) as Record<string, unknown>;
  const primordials = load(NODE_VM_PREPARED_MODULES.primordials);
  const interpreterModule = load(NODE_VM_PREPARED_MODULES.interpreter);
  runtimeModules = {
    createInterpreter: interpreterModule.createInterpreter,
    hostOps: load(NODE_VM_PREPARED_MODULES.hostOps),
    primordials: primordials.LAUNCH_PRIMORDIALS,
    moduleHelpers: load(NODE_VM_PREPARED_MODULES.moduleHelpers),
    hasSyntheticArgumentsReference: load(NODE_VM_PREPARED_MODULES.expressionAnalysis).hasSyntheticArgumentsReference,
  } as unknown as NodeVmRuntimeModules;

  fallback = createNodeVm(refusingVm(), runtimeModules, refusingFunctionConstructors());
});

afterAll(async () => {
  if (preparedDirectory) {
    await NodeFSP.rm(preparedDirectory, { recursive: true, force: true });
  }
  if (originalFunctionToString) {
    Object.defineProperty(Function.prototype, "toString", originalFunctionToString);
  }
});

describe("Node vm interpreter fallback", () => {
  it("uses the native implementation unless it refuses code generation", () => {
    const nativeFunction = () => 17;
    const native = createNodeVm(
      {
        ...NodeVM,
        runInThisContext: () => "native",
        compileFunction: () => nativeFunction,
      } as unknown as NodeVmNativeSurface,
      runtimeModulesForTest(),
    );

    expect(native.module.runInThisContext("ignored")).toBe("native");
    expect(native.module.compileFunction("ignored")).toBe(nativeFunction);
  });

  it("runs vm functions in the same realm and preserves closures and object identity", () => {
    const shared = { count: 0 };
    Object.defineProperty(globalThis, "__signalboxNodeVmShared", {
      value: shared,
      configurable: true,
      writable: true,
    });
    try {
      const mutate = fallback.module.compileFunction(
        "__signalboxNodeVmShared.count += amount; return __signalboxNodeVmShared",
        ["amount"],
      ) as (amount: number) => typeof shared;
      expect(mutate(2)).toBe(shared);
      expect(shared.count).toBe(2);

      const makeCounter = fallback.functionConstructors.Function(
        "let count = 0; return () => ++count",
      ) as () => () => number;
      const next = makeCounter();
      expect(next()).toBe(1);
      expect(next()).toBe(2);
      expect(Object.getPrototypeOf(next)).toBe(Function.prototype);
    } finally {
      Reflect.deleteProperty(globalThis, "__signalboxNodeVmShared");
    }
  });

  it("does not rerun guest code when it throws a code-generation-shaped error", () => {
    const refusal = new Error("guest error with a native refusal code");
    Object.defineProperty(refusal, "code", { value: "ERR_METHOD_NOT_IMPLEMENTED" });
    let executions = 0;
    const key = "__signalboxNodeVmGuestThrowsRefusal";
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      value: () => {
        executions++;
        throw refusal;
      },
      configurable: true,
    });
    try {
      const native = createNodeVm({ ...NodeVM }, runtimeModulesForTest());
      expect(() => native.module.runInThisContext(`globalThis.${key}()`)).toThrow(refusal);
      expect(executions).toBe(1);
    } finally {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  it("refuses parser-identified synthetic script arguments references", () => {
    const guarded = createNodeVm(
      refusingVm(),
      {
        ...runtimeModulesForTest(),
      },
      refusingFunctionConstructors(),
    );

    expect(() => guarded.module.runInThisContext("typeof arguments")).toThrow(
      expect.objectContaining({
        code: "ERR_NODE_VM_UNSUPPORTED_SYNTAX",
        feature: "script-scoped arguments",
      }),
    );
    expect(() => guarded.module.runInThisContext("(() => arguments)()")).toThrow(
      expect.objectContaining({ code: "ERR_NODE_VM_UNSUPPORTED_SYNTAX" }),
    );
    expect(guarded.module.runInThisContext("'arguments'")).toBe("arguments");
    expect(guarded.module.runInThisContext("({ arguments: 7 }).arguments")).toBe(7);
    expect(guarded.module.runInThisContext("(arguments => arguments)(7)")).toBe(7);
    expect(guarded.module.runInThisContext("(function () { return arguments.length; })(1)")).toBe(1);
  });

  it("keeps strict and sloppy function semantics for the function constructor", () => {
    const sloppyThis = new fallback.functionConstructors.Function("return this") as () => unknown;
    const strictThis = new fallback.functionConstructors.Function(
      "'use strict'; return this",
    ) as () => unknown;

    expect(sloppyThis()).toBe(globalThis);
    expect(strictThis()).toBeUndefined();
  });

  it("supports async and generator Function siblings with their native kinds", async () => {
    const asyncFunction = new fallback.functionConstructors.AsyncFunction(
      "return 23",
    ) as () => Promise<number>;
    const generatorFunction = new fallback.functionConstructors.GeneratorFunction(
      "yield 29",
    ) as () => Generator<number, void, unknown>;
    const asyncGeneratorFunction = new fallback.functionConstructors.AsyncGeneratorFunction(
      "yield 31",
    ) as () => AsyncGenerator<number, void, unknown>;

    expect(await asyncFunction()).toBe(23);
    expect(generatorFunction().next()).toEqual({ value: 29, done: false });
    expect(await asyncGeneratorFunction().next()).toEqual({ value: 31, done: false });
  });

  it("coerces function constructor parameters and body once before fallback", () => {
    let parameterCoercions = 0;
    let bodyCoercions = 0;
    const parameter = {
      toString() {
        parameterCoercions++;
        return parameterCoercions === 1 ? "value" : "wrong";
      },
    };
    const body = {
      toString() {
        bodyCoercions++;
        return bodyCoercions === 1 ? "return value" : "return 2";
      },
    };
    const construct = fallback.functionConstructors.Function as (...args: unknown[]) => Function;
    const fn = construct(parameter, body) as (value: string) => string;

    expect(fn("once")).toBe("once");
    expect(parameterCoercions).toBe(1);
    expect(bodyCoercions).toBe(1);
    expect(() => construct(Symbol("body"))).toThrow(TypeError);

    const coercionError = new Error("parameter conversion failed");
    expect(() =>
      construct({
        toString: () => {
          throw coercionError;
        },
      }),
    ).toThrow(coercionError);
  });

  it("limits runInThisContext to checked single-expression scripts", () => {
    expect(fallback.module.runInThisContext("1 + 2")).toBe(3);
    expect(
      fallback.module.runInThisContext("'use strict'; (function () { return this; })()"),
    ).toBeUndefined();
    expect(() =>
      fallback.module.runInThisContext("globalThis.__signalboxNodeVmEscaped = 1; 2"),
    ).toThrow(expect.objectContaining({ code: "ERR_NIMBUS_INTERPRETER_UNSUPPORTED" }));
    expect(Reflect.get(globalThis, "__signalboxNodeVmEscaped")).toBeUndefined();
    expect(() => fallback.module.runInThisContext("(")).toThrow(SyntaxError);
  });

  it("rejects source-boundary escapes before any injected code can run", () => {
    const injected = "__signalboxNodeVmEscaped";
    expect(() =>
      fallback.functionConstructors.Function(
        `value) { globalThis.${injected} = true; } //`,
        "return 1",
      ),
    ).toThrow(SyntaxError);
    expect(() =>
      fallback.functionConstructors.Function("value", `}; globalThis.${injected} = true; //`),
    ).toThrow(SyntaxError);
    expect(() =>
      fallback.module.compileFunction("return 1", [`value) { globalThis.${injected} = true; } //`]),
    ).toThrow(SyntaxError);
    expect(() =>
      fallback.module.compileFunction(`}; globalThis.${injected} = true; //`, ["value"]),
    ).toThrow(SyntaxError);
    expect(Reflect.get(globalThis, injected)).toBeUndefined();
  });

  it("parses after guest code replaces mutable realm helpers", () => {
    const originalPush = Object.getOwnPropertyDescriptor(Array.prototype, "push");
    let result: unknown;
    Object.defineProperty(Array.prototype, "push", {
      value: () => {
        throw new Error("parser reached guest Array.prototype.push");
      },
      configurable: true,
      writable: true,
    });
    try {
      result = fallback.module.compileFunction("return 41")();
    } finally {
      if (originalPush) Object.defineProperty(Array.prototype, "push", originalPush);
    }
    expect(result).toBe(41);
  });

  it("reports syntax errors and unsupported vm options without broad fallback", () => {
    expect(() => fallback.module.compileFunction("return )")).toThrow(SyntaxError);
    expect(() =>
      fallback.module.compileFunction("return 1", [], { contextExtensions: [{}] }),
    ).toThrow(
      expect.objectContaining({
        code: "ERR_NODE_VM_UNSUPPORTED_OPTION",
        option: "contextExtensions",
      }),
    );
    expect(() => fallback.module.runInThisContext("1", "fixture.js")).toThrow(
      expect.objectContaining({ code: "ERR_NODE_VM_UNSUPPORTED_OPTION", option: "filename" }),
    );

    const unrelated = new Error("native failure unrelated to code generation");
    const native = createNodeVm(
      {
        ...NodeVM,
        runInThisContext: () => {
          throw unrelated;
        },
      } as unknown as NodeVmNativeSurface,
      runtimeModulesForTest(),
    );
    expect(() => native.module.runInThisContext("1")).toThrow(unrelated);
  });

  it("preserves constructor, new-target, and prototype relationships", () => {
    const { Function: FunctionShim } = fallback.functionConstructors;
    const Derived = class extends (FunctionShim as new (...args: string[]) => Function) {};
    const fn = new Derived("return 37");

    expect(fn()).toBe(37);
    expect(Object.getPrototypeOf(fn)).toBe(Derived.prototype);
    expect(FunctionShim.prototype).toBe(Function.prototype);
  });

  it("installs and restores the global Function constructor under explicit ownership", async () => {
    const originalFunction = Object.getOwnPropertyDescriptor(globalThis, "Function");
    const originalConstructor = Object.getOwnPropertyDescriptor(Function.prototype, "constructor");
    const nativeAsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const nativeGeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
    const nativeAsyncGeneratorFunction = Object.getPrototypeOf(async function* () {}).constructor;
    const nativeAsyncParent = Object.getPrototypeOf(nativeAsyncFunction);
    const nativeGeneratorParent = Object.getPrototypeOf(nativeGeneratorFunction);
    const nativeAsyncGeneratorParent = Object.getPrototypeOf(nativeAsyncGeneratorFunction);
    const shims = createNodeVm(refusingVm(), runtimeModules).functionConstructors;
    const installation = shims.install();
    try {
      expect(globalThis.Function).toBe(shims.Function);
      expect(Function.prototype.constructor).toBe(shims.Function);
      expect((async function () {}).constructor).toBe(shims.AsyncFunction);
      expect((function* () {}).constructor).toBe(shims.GeneratorFunction);
      expect((async function* () {}).constructor).toBe(shims.AsyncGeneratorFunction);
      expect(Object.getPrototypeOf((async function () {}).constructor)).toBe(globalThis.Function);
      expect(Object.getPrototypeOf((function* () {}).constructor)).toBe(globalThis.Function);
      expect(Object.getPrototypeOf((async function* () {}).constructor)).toBe(globalThis.Function);
      expect(Object.getPrototypeOf(shims.AsyncFunction)).toBe(shims.Function);
      expect(Object.getPrototypeOf(shims.GeneratorFunction)).toBe(shims.Function);
      expect(Object.getPrototypeOf(shims.AsyncGeneratorFunction)).toBe(shims.Function);
      const generatedAsync = ((async function () {}).constructor as (...args: string[]) => Function)(
        "return 43",
      ) as () => Promise<number>;
      const generatedGenerator = ((function* () {}).constructor as (...args: string[]) => Function)(
        "yield 47",
      ) as () => Generator<number, void, unknown>;
      const generatedAsyncGenerator = ((async function* () {}).constructor as (
        ...args: string[]
      ) => Function)("yield 53") as () => AsyncGenerator<number, void, unknown>;
      expect(await generatedAsync()).toBe(43);
      expect(generatedGenerator().next().value).toBe(47);
      expect((await generatedAsyncGenerator().next()).value).toBe(53);
      expect(Object.getPrototypeOf(nativeAsyncFunction)).toBe(nativeAsyncParent);
      expect(Object.getPrototypeOf(nativeGeneratorFunction)).toBe(nativeGeneratorParent);
      expect(Object.getPrototypeOf(nativeAsyncGeneratorFunction)).toBe(
        nativeAsyncGeneratorParent,
      );
    } finally {
      installation.restore();
    }
    expect((async function () {}).constructor).toBe(nativeAsyncFunction);
    expect((function* () {}).constructor).toBe(nativeGeneratorFunction);
    expect((async function* () {}).constructor).toBe(nativeAsyncGeneratorFunction);
    expect(Object.getPrototypeOf(nativeAsyncFunction)).toBe(nativeAsyncParent);
    expect(Object.getPrototypeOf(nativeGeneratorFunction)).toBe(nativeGeneratorParent);
    expect(Object.getPrototypeOf(nativeAsyncGeneratorFunction)).toBe(
      nativeAsyncGeneratorParent,
    );
    expect(Object.getOwnPropertyDescriptor(globalThis, "Function")).toEqual(originalFunction);
    expect(Object.getOwnPropertyDescriptor(Function.prototype, "constructor")).toEqual(
      originalConstructor,
    );
  });
});

function refusingVm(): NodeVmNativeSurface {
  const refuse = () => {
    const error = new Error("vm method not implemented by workerd");
    Object.defineProperty(error, "code", { value: "ERR_METHOD_NOT_IMPLEMENTED" });
    throw error;
  };
  return {
    ...NodeVM,
    runInThisContext: refuse,
    compileFunction: refuse,
  } as unknown as NodeVmNativeSurface;
}

function refusingFunctionConstructors(): NodeVmNativeFunctionConstructors {
  const refuse = (native: Function): NodeVmFunctionConstructor => {
    const constructor = function (...args: unknown[]) {
      for (const arg of args) {
        if (typeof arg === "symbol") {
          throw new TypeError("Cannot convert a Symbol value to a string");
        }
        String(arg);
      }
      const error = new EvalError("Code generation from strings disallowed for this context");
      throw error;
    };
    Object.defineProperty(constructor, "name", { value: native.name });
    Object.defineProperty(constructor, "prototype", { value: native.prototype, writable: false });
    Object.setPrototypeOf(constructor, Object.getPrototypeOf(native));
    return constructor as unknown as NodeVmFunctionConstructor;
  };
  return {
    Function: refuse(Function),
    AsyncFunction: refuse(Object.getPrototypeOf(async function () {}).constructor as Function),
    GeneratorFunction: refuse(Object.getPrototypeOf(function* () {}).constructor as Function),
    AsyncGeneratorFunction: refuse(
      Object.getPrototypeOf(async function* () {}).constructor as Function,
    ),
  };
}

function runtimeModulesForTest(): NodeVmRuntimeModules {
  return runtimeModules;
}
