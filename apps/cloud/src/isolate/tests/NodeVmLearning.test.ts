/* eslint-disable no-extend-native -- Guest prototype changes exercise constructor and parser isolation. */
// @effect-diagnostics nodeBuiltinImport:off - isolated SQLite and prepared modules, never live userdata.
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeVM from "node:vm";
import * as Esbuild from "esbuild";
import {
  createNodeVm,
  type NodeVmNativeFunctionConstructors,
  type NodeVmPreparedFunctionFactory,
  type NodeVmRuntimeModules,
} from "../NodeVm.ts";
import {
  createNodeGeneratedCode,
  nodeGeneratedFunctionSourceKey,
  type NodeGeneratedCodeModuleMap,
  type NodeGeneratedFunctionCode,
  type NodeGeneratedFunctionModuleRuntime,
} from "../NodeGeneratedCode.ts";
import {
  NODE_VM_PREPARED_MODULES,
  prepareNodeVmModules,
} from "../../../infra/nodeProof/prepareVm.ts";
import { prepareNodeVmLearningProof } from "../../../infra/nodeProof/prepareLearning.ts";

import { nodeGeneratedCodeSqliteFixture as sqlite } from "./generatedCodeFixture.ts";

let directory: string;
let load: NodeJS.Require;
let runtime: NodeVmRuntimeModules;
let functionRuntime: NodeGeneratedFunctionModuleRuntime;
let registerSource: (fn: object, source: string) => void;
const originalToString = Object.getOwnPropertyDescriptor(Function.prototype, "toString")!;
const refused = () => {
  throw new EvalError("Code generation from strings disallowed for this context");
};
const refusingVm = { runInThisContext: refused, compileFunction: refused };
const nativeKinds = [
  Function,
  Object.getPrototypeOf(async function () {}).constructor,
  Object.getPrototypeOf(function* () {}).constructor,
  Object.getPrototypeOf(async function* () {}).constructor,
] as Function[];
const constructors = Object.fromEntries(
  nativeKinds.map((native) => {
    const reject = function () {
      return refused();
    };
    Object.defineProperty(reject, "prototype", { value: native.prototype });
    return [native.name, reject];
  }),
) as unknown as NodeVmNativeFunctionConstructors;

beforeAll(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "node-vm-learning-"));
  await prepareNodeVmModules(directory);
  load = NodeModule.createRequire(NodePath.join(directory, "load.cjs"));
  const get = (name: string) => load(NodePath.join(directory, name));
  const primordials = get(NODE_VM_PREPARED_MODULES.primordials);
  runtime = {
    createInterpreter: get(NODE_VM_PREPARED_MODULES.interpreter).createInterpreter,
    hostOps: get(NODE_VM_PREPARED_MODULES.hostOps),
    primordials: primordials.LAUNCH_PRIMORDIALS,
    moduleHelpers: get(NODE_VM_PREPARED_MODULES.moduleHelpers),
    hasSyntheticArgumentsReference: get(NODE_VM_PREPARED_MODULES.expressionAnalysis)
      .hasSyntheticArgumentsReference,
    canStageFunction: get(NODE_VM_PREPARED_MODULES.expressionAnalysis).canStageFunction,
  };
  registerSource = primordials.registerSource;
  functionRuntime = get(NODE_VM_PREPARED_MODULES.functionRuntime);
});

afterAll(async () => {
  Object.defineProperty(Function.prototype, "toString", originalToString);
  if (directory) await NodeFSP.rm(directory, { recursive: true, force: true });
});

function countedRuntime() {
  let interpreted = 0;
  return {
    modules: {
      ...runtime,
      createInterpreter: (...args: Parameters<NodeVmRuntimeModules["createInterpreter"]>) => {
        const interpreter = runtime.createInterpreter(...args);
        return {
          ...interpreter,
          compileFunction: (...input: Parameters<typeof interpreter.compileFunction>) => {
            interpreted++;
            return interpreter.compileFunction(...input);
          },
        };
      },
    },
    count: () => interpreted,
  };
}

async function preload(map: NodeGeneratedCodeModuleMap) {
  const modules: Record<string, NodeVmPreparedFunctionFactory> = Object.create(null);
  let native = 0;
  for (const [name, source] of Object.entries(map.modules)) {
    const path = NodePath.join(directory, name);
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, source);
    const factory = load(path) as NodeVmPreparedFunctionFactory;
    const counted = (...args: Parameters<NodeVmPreparedFunctionFactory>) => {
      native++;
      return factory(...args);
    };
    Object.assign(counted, {
      source: factory.source,
      ...(factory.unbound
        ? {
            unbound: (importer: Parameters<NodeVmPreparedFunctionFactory>[0]) => {
              native++;
              return factory.unbound!(importer);
            },
          }
        : {}),
    });
    modules[name] = counted;
  }
  return {
    prepared: { functionIndex: map.functionIndex, modules, registerSource },
    count: () => native,
  };
}

async function isolatedLearningScenario<T>(
  source: string,
  inputs: Record<string, unknown> = {},
): Promise<T> {
  const bundle = await Esbuild.build({
    stdin: {
      contents:
        'export {createNodeGeneratedCode} from "./NodeGeneratedCode.ts"; export {createNodeVm} from "./NodeVm.ts";',
      resolveDir: new URL("../", import.meta.url).pathname,
    },
    bundle: true,
    platform: "node",
    packages: "external",
    format: "cjs",
    write: false,
  });
  const completed = Promise.withResolvers<{ value?: T; error?: string }>();
  const context = NodeVM.createContext({
    module: { exports: {} },
    require: NodeModule.createRequire(import.meta.url),
    crypto: globalThis.crypto,
    TextEncoder,
    functionRuntime,
    runtime,
    constructors,
    refusingVm,
    done: completed.resolve,
    ...inputs,
  });
  NodeVM.runInContext(bundle.outputFiles![0]!.text, context);
  NodeVM.runInContext(
    `void (async () => {
    try { done({value:await (async () => {${source}})()}); }
    catch(error) { done({error:String(error)+'\\n'+error.stack}); }
  })();`,
    context,
  );
  const result = await completed.promise;
  if (result.error !== undefined) throw new Error(result.error);
  return result.value as T;
}

describe("Node vm generated-function learning", () => {
  it("hashes exact UTF-8 across SHA-256 block boundaries with persistent throwing builtin hooks", async () => {
    const fixture = sqlite();
    const bodies = [0, 1, 31, 32, 33, 55, 56, 63, 64, 65, 127, 128, 129, 4096].map(
      (length) => `return ${JSON.stringify("a".repeat(length) + "Grüezi 😀")}`,
    );
    const expected = bodies.map((body) =>
      NodeCrypto.createHash("sha256")
        .update(JSON.stringify(["function", [], body]))
        .digest("hex"),
    );
    try {
      const result = await isolatedLearningScenario<{
        hooks: number;
        hashes: string[];
        recovered: number;
      }>(
        `
        const generated = module.exports.createNodeGeneratedCode({storage,scopeId:'hash-helpers',functionRuntime});
        const define = Object.defineProperty;
        const own = Object.getOwnPropertyDescriptor;
        const typed = Object.getPrototypeOf(Uint8Array.prototype);
        const bodies = ${JSON.stringify(bodies)};
        const targets = [
          [Object,'getPrototypeOf'],[Object,'getOwnPropertyDescriptor'],[Object,'keys'],
          [Reflect,'apply'],[Array,'from'],[Array.prototype,Symbol.iterator],
          [Array.prototype,'map'],[Array.prototype,'push'],[Array.prototype,'join'],
          [Math,'min'],[TextEncoder.prototype,'encode'],
          [typed,'buffer'],[typed,'byteLength'],[typed,'byteOffset'],[typed,'length'],
          [typed,Symbol.iterator],[typed,'set'],[typed,'subarray'],[typed,'slice'],[typed,'fill'],
          [DataView.prototype,'getUint32'],[DataView.prototype,'setUint32'],[DataView.prototype,'setBigUint64'],
          [Object.prototype,'then'],[Object.prototype,'A'],
        ];
        const descriptors = targets.map(([target,key]) => own(target,key));
        const hashes = [];Object.setPrototypeOf(hashes,null);
        let hooks = 0;
        const unexpected = () => {hooks++;throw new Error('Guest hash helper ran');};
        try {
          for(let index=0;index<targets.length;index++){
            const target = targets[index][0];const key = targets[index][1];
            define(target,key,{get:unexpected,configurable:true});
          }
          for(let index=0;index<bodies.length;index++){
            hashes[index] = await generated.learnFunction({kind:'function',params:[],body:bodies[index]});
          }
        }finally{
          for(let index=0;index<targets.length;index++){
            const target = targets[index][0];const key = targets[index][1];
            if(descriptors[index])define(target,key,descriptors[index]);else delete target[key];
          }
        }
        await generated.learnFunction({kind:'function',params:[],body:bodies[0]});
        return {hooks,hashes:Array.from(hashes),recovered:Object.keys((await generated.prepare(1048576)).modules).length};
      `,
        { storage: fixture.storage },
      );
      expect(result).toEqual({ hooks: 0, hashes: expected, recovered: 1 });
    } finally {
      fixture.close();
    }
  });

  it("boots and retains functions when TextEncoder is an inherited data binding", async () => {
    const bundle = await Esbuild.build({
      entryPoints: [new URL("../NodeGeneratedCode.ts", import.meta.url).pathname],
      bundle: true,
      platform: "node",
      packages: "external",
      format: "cjs",
      write: false,
    });
    const sandbox = {
      TextEncoder,
      module: { exports: {} },
      require: NodeModule.createRequire(import.meta.url),
      crypto: globalThis.crypto,
    };
    const context = NodeVM.createContext(sandbox);
    NodeVM.runInContext(
      "const inherited = Object.create(Object.getPrototypeOf(globalThis)); inherited.TextEncoder = TextEncoder; delete globalThis.TextEncoder; Object.setPrototypeOf(globalThis, inherited)",
      context,
    );
    expect(
      NodeVM.runInContext(
        "Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder') === undefined",
        context,
      ),
    ).toBe(true);
    const api = NodeVM.runInContext(
      bundle.outputFiles![0]!.text + ";module.exports",
      context,
    ) as Pick<typeof import("../NodeGeneratedCode.ts"), "createNodeGeneratedCode">;
    const fixture = sqlite();
    try {
      const generated = api.createNodeGeneratedCode({
        storage: fixture.storage,
        scopeId: "inherited-binding",
        functionRuntime,
      });
      const entry = NodeVM.runInContext(
        "({kind:'function',params:[],body:'return 1'})",
        context,
      ) as NodeGeneratedFunctionCode;
      await generated.learnFunction(entry);
      expect(Object.keys((await generated.prepare(Number.MAX_SAFE_INTEGER)).modules)).toHaveLength(
        1,
      );
    } finally {
      fixture.close();
    }
  });

  it("does not reenter native validators after guest hooks replace realm helpers", async () => {
    const fixture = sqlite();
    const generated = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "native-validator",
      functionRuntime,
    });
    const vm = createNodeVm(
      {
        runInThisContext: refused,
        compileFunction(_source: string, params: unknown) {
          // Workerd validates native arguments with live helpers before refusing string compilation.
          if (!Array.isArray(params)) throw new TypeError("Expected parameter array");
          return refused();
        },
      },
      runtime,
      constructors,
      { learning: generated },
    );
    const define = Object.defineProperty;
    const descriptor = Object.getOwnPropertyDescriptor(Array, "isArray")!;
    let hooks = 0;
    let compiled: unknown;
    let expression: unknown;
    try {
      try {
        define(Array, "isArray", {
          value() {
            hooks++;
            throw new Error("Guest hook reached native validation");
          },
          writable: true,
          configurable: true,
        });
        compiled = vm.module.compileFunction("return value", ["value"])(17);
        expression = vm.module.runInThisContext("1 + 2");
        await vm.flushLearning();
      } finally {
        define(Array, "isArray", descriptor);
      }
      expect({ hooks, compiled, expression }).toEqual({ hooks: 0, compiled: 17, expression: 3 });
      expect(Object.keys((await generated.prepare(1048576)).modules)).toHaveLength(0);
      vm.module.compileFunction("return value", ["value"])(17);
      await vm.flushLearning();
      expect(Object.keys((await generated.prepare(1048576)).modules)).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  it("propagates native capability errors that are unrelated to code-generation refusal", () => {
    const failure = Object.assign(new Error("Native validator failed"), {
      code: "ERR_INVALID_ARG_VALUE",
    });
    expect(() =>
      createNodeVm(
        {
          runInThisContext: refused,
          compileFunction() {
            throw failure;
          },
        },
        runtime,
        constructors,
      ),
    ).toThrow(failure);
  });

  it("learns real interpreted functions and uses precompiled factories on the next boot", async () => {
    const fixture = sqlite();
    const generated = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "a",
      functionRuntime,
    });
    const coldRuntime = countedRuntime();
    const cold = createNodeVm(refusingVm, coldRuntime.modules, constructors, {
      learning: generated,
    });
    const shared = { n: 0 };
    const run = async (vm: ReturnType<typeof createNodeVm>) => {
      const body = "value.n++; return value";
      expect(vm.module.compileFunction(body, ["value"])(shared)).toBe(shared);
      expect(vm.functionConstructors.Function("value", body)(shared)).toBe(shared);
      expect(await vm.functionConstructors.AsyncFunction("value", "return value")(shared)).toBe(
        shared,
      );
      expect(
        vm.functionConstructors.GeneratorFunction("value", "yield value")(shared).next().value,
      ).toBe(shared);
      expect(
        (
          await vm.functionConstructors
            .AsyncGeneratorFunction(
              "value",
              "yield value",
            )(shared)
            .next()
        ).value,
      ).toBe(shared);
      expect(vm.functionConstructors.Function("return this")()).toBe(globalThis);
      expect(vm.functionConstructors.Function("'use strict'; return this")()).toBeUndefined();
      expect(vm.functionConstructors.Function("return Function")()).toBe(globalThis.Function);
      expect(vm.functionConstructors.Function("return typeof require")()).toBe(
        typeof Reflect.get(globalThis, "require"),
      );
      const imports = vm.functionConstructors.Function("return import('node:path')");
      await expect(imports()).rejects.toMatchObject({
        code: "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING",
      });
      expect(imports.toString()).toContain("import('node:path')");
      const next = vm.functionConstructors.Function("let n = 0; return () => ++n")();
      expect(next()).toBe(1);
      expect(next()).toBe(2);
      const Derived = class extends vm.functionConstructors.Function {};
      const derived = new Derived("return this");
      expect(Object.getPrototypeOf(derived)).toBe(Derived.prototype);
      const error = Object.assign(new Error("newTarget getter failed"), {
        code: "ERR_METHOD_NOT_IMPLEMENTED",
      });
      let prototypeReads = 0;
      const target = new Proxy(function Target() {}, {
        get(value, key, receiver) {
          if (key === "prototype") {
            prototypeReads++;
            throw error;
          }
          return Reflect.get(value, key, receiver);
        },
      });
      expect(() =>
        Reflect.construct(vm.functionConstructors.Function, ["return this"], target),
      ).toThrow(error);
      expect(prototypeReads).toBe(1);
    };
    try {
      await run(cold);
      await cold.flushLearning();
      const prepared = await generated.prepare(Number.MAX_SAFE_INTEGER);
      expect(Object.keys(prepared.modules)).toHaveLength(9);
      expect(coldRuntime.count()).toBe(12);
      const preloaded = await preload(prepared);
      const warmRuntime = countedRuntime();
      const warm = createNodeVm(refusingVm, warmRuntime.modules, constructors, {
        prepared: preloaded.prepared,
      });
      await run(warm);
      expect(warmRuntime.count()).toBe(1);
      expect(preloaded.count()).toBe(11);
      expect(shared.n).toBe(4);
      const [name] = Object.keys(prepared.modules);
      const factory = load(NodePath.join(directory, name!)) as NodeVmPreparedFunctionFactory;
      expect(typeof factory).toBe("function");
      const coldProof = NodePath.join(directory, "cold-proof");
      const nextProof = NodePath.join(directory, "next-proof");
      await prepareNodeVmLearningProof(coldProof, { preparedDirectory: directory });
      await prepareNodeVmLearningProof(nextProof, { preparedDirectory: directory, prepared });
      const manifest = JSON.parse(
        await NodeFSP.readFile(NodePath.join(nextProof, "manifest.json"), "utf8"),
      );
      expect(manifest.allowGeneratedCode).toBeUndefined();
      expect(Object.keys(manifest.modules).filter((name) => name.startsWith("gen/"))).toHaveLength(
        9,
      );
    } finally {
      fixture.close();
    }
  });

  it("persists only successful interpreter compilation and reads guest inputs once", async () => {
    const fixture = sqlite();
    const generated = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "success",
      functionRuntime,
    });
    const vm = createNodeVm(refusingVm, runtime, constructors, { learning: generated });
    let coercions = 0;
    const body = {
      toString() {
        coercions++;
        return "return 73";
      },
    };
    const failure = Object.assign(new Error("getter failed"), {
      code: "ERR_METHOD_NOT_IMPLEMENTED",
    });
    let reads = 0;
    const params = Object.defineProperty(["value"], 0, {
      get() {
        reads++;
        throw failure;
      },
    });
    try {
      expect(Reflect.apply(vm.functionConstructors.Function, undefined, [body])()).toBe(73);
      expect(coercions).toBe(1);
      expect(() => vm.module.compileFunction("return value", params)).toThrow(failure);
      expect(reads).toBe(1);
      expect(() => vm.module.compileFunction("return )")).toThrow(SyntaxError);
      expect(() =>
        vm.functionConstructors.Function("x) { globalThis.__escape = 1 } //", "return 1"),
      ).toThrow(SyntaxError);
      expect(() => vm.functionConstructors.Function("}; globalThis.__escape = 1; //")).toThrow(
        SyntaxError,
      );
      expect(Reflect.get(globalThis, "__escape")).toBeUndefined();
      expect(() => vm.module.compileFunction("return 1", [], { timeout: 1 })).toThrow();
      expect(() => vm.module.compileFunction("return 1", [], Object.create({}))).toThrow();
      const options = Object.defineProperty({}, "timeout", {
        get() {
          throw failure;
        },
      });
      expect(() => vm.module.compileFunction("return 1", [], options)).toThrow(/timeout/);
      await vm.flushLearning();
      expect(Object.keys((await generated.prepare(Number.MAX_SAFE_INTEGER)).modules)).toHaveLength(
        1,
      );
    } finally {
      fixture.close();
    }
  });

  it("keeps omissions and other scopes on the interpreter path", async () => {
    const fixture = sqlite();
    const generated = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "a",
      functionRuntime,
    });
    try {
      const cold = createNodeVm(refusingVm, runtime, constructors, { learning: generated });
      cold.functionConstructors.Function("return 89");
      await cold.flushLearning();
      const omitted = await generated.prepare(0);
      expect(omitted.omittedKeys).toHaveLength(1);
      expect(omitted.functionIndex).toEqual({});
      const counted = countedRuntime();
      const boot = await preload(omitted);
      const warm = createNodeVm(refusingVm, counted.modules, constructors, {
        prepared: boot.prepared,
        learning: generated,
      });
      expect(warm.functionConstructors.Function("return 89")()).toBe(89);
      expect(counted.count()).toBe(1);
      await warm.flushLearning();
      const other = createNodeGeneratedCode({
        storage: fixture.storage,
        scopeId: "b",
        functionRuntime,
      });
      expect((await other.prepare(Number.MAX_SAFE_INTEGER)).modules).toEqual({});
    } finally {
      fixture.close();
    }
  });

  it("persists cold compilations without calling replaced array helpers or iterators", async () => {
    const fixture = sqlite();
    const generated = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "normalization-hooks",
      functionRuntime,
    });
    const vm = createNodeVm(refusingVm, runtime, constructors, { learning: generated });
    const define = Object.defineProperty;
    const keys = ["includes", "push", Symbol.iterator] as const;
    const descriptors = keys.map((key) => Object.getOwnPropertyDescriptor(Array.prototype, key)!);
    const shared = { value: 17 };
    let replacementCalls = 0;
    let scalar: unknown;
    let identity: unknown;
    try {
      for (let index = 0; index < keys.length; index++) {
        define(Array.prototype, keys[index]!, {
          configurable: true,
          writable: true,
          value() {
            replacementCalls++;
            throw new Error("A replaced array helper ran during cold learning");
          },
        });
      }
      try {
        scalar = vm.module.compileFunction("return 1")();
        identity = vm.functionConstructors.Function("value", "return value")(shared);
      } finally {
        for (let index = 0; index < keys.length; index++)
          define(Array.prototype, keys[index]!, descriptors[index]!);
      }
      await vm.flushLearning();
      const map = await generated.prepare(Number.MAX_SAFE_INTEGER);
      expect(replacementCalls).toBe(0);
      expect(scalar).toBe(1);
      expect(identity).toBe(shared);
      expect(Object.keys(map.modules)).toHaveLength(2);
      const loaded = await preload(map);
      const counted = countedRuntime();
      const warm = createNodeVm(refusingVm, counted.modules, constructors, {
        prepared: loaded.prepared,
      });
      expect(warm.module.compileFunction("return 1")()).toBe(1);
      expect(warm.functionConstructors.Function("value", "return value")(shared)).toBe(shared);
      expect(counted.count()).toBe(0);
      expect(loaded.count()).toBe(2);
    } finally {
      fixture.close();
    }
  });

  it("skips retention without guest hooks while replacements remain installed through flushLearning", async () => {
    const fixture = sqlite();
    const generated = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "persistent-hooks",
      functionRuntime,
    });
    const vm = createNodeVm(refusingVm, runtime, constructors, { learning: generated });
    const define = Object.defineProperty;
    const own = Object.getOwnPropertyDescriptor;
    const arrayIterator = Object.getPrototypeOf([][Symbol.iterator]());
    const replacements = [
      [Array.prototype, Symbol.iterator],
      [arrayIterator, "next"],
      [Array.prototype, "map"],
      [Array.prototype, "sort"],
      [Array.prototype, "push"],
      [Array.prototype, "join"],
      [Set.prototype, "add"],
      [Set.prototype, "has"],
      [Object, "keys"],
      [String.prototype, "slice"],
      [Reflect, "get"],
      [Array, "isArray"],
      [Array, "from"],
      [JSON, "stringify"],
      [TextEncoder.prototype, "encode"],
      [Number, "isSafeInteger"],
      [Math, "min"],
    ] as const;
    let calls = 0;
    const unexpected = () => {
      calls++;
      throw new Error("A persistent guest hook ran during learning");
    };
    const shared = { value: 17 };
    try {
      for (let index = 0; index < replacements.length; index++) {
        const target = replacements[index]![0];
        const key = replacements[index]![1];
        const descriptor = own(target, key)!;
        let scalar: unknown;
        let identity: unknown;
        try {
          define(target, key, { value: unexpected, writable: true, configurable: true });
          scalar = vm.module.compileFunction("return 1")();
          identity = vm.functionConstructors.Function("value", "return value")(shared);
          await vm.flushLearning();
        } finally {
          define(target, key, descriptor);
        }
        expect(calls).toBe(0);
        expect(scalar).toBe(1);
        expect(identity).toBe(shared);
        expect(
          Object.keys((await generated.prepare(Number.MAX_SAFE_INTEGER)).modules),
        ).toHaveLength(0);
      }
      const descriptor = own(Array.prototype, "map")!;
      try {
        define(Array.prototype, "map", { get: unexpected, configurable: true });
        expect(vm.module.compileFunction("return 1")()).toBe(1);
        await vm.flushLearning();
      } finally {
        define(Array.prototype, "map", descriptor);
      }
      const setBinding = own(globalThis, "Set")!;
      const proxy = new Proxy(Set, {
        get: unexpected,
        getOwnPropertyDescriptor: unexpected,
        getPrototypeOf: unexpected,
      });
      try {
        define(globalThis, "Set", { value: proxy, writable: true, configurable: true });
        vm.module.compileFunction("return 1")();
        await vm.flushLearning();
      } finally {
        define(globalThis, "Set", setBinding);
      }
      expect(calls).toBe(0);
      expect(Object.keys((await generated.prepare(Number.MAX_SAFE_INTEGER)).modules)).toHaveLength(
        0,
      );
      expect(vm.module.compileFunction("return 1")()).toBe(1);
      expect(vm.functionConstructors.Function("value", "return value")(shared)).toBe(shared);
      await vm.flushLearning();
      const map = await generated.prepare(Number.MAX_SAFE_INTEGER);
      expect(Object.keys(map.modules)).toHaveLength(2);
      const loaded = await preload(map);
      const counted = countedRuntime();
      const warm = createNodeVm(refusingVm, counted.modules, constructors, {
        prepared: loaded.prepared,
      });
      expect(warm.module.compileFunction("return 1")()).toBe(1);
      expect(warm.functionConstructors.Function("value", "return value")(shared)).toBe(shared);
      expect(loaded.count()).toBe(2);
      expect(counted.count()).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it("uses the captured byte-length getter through learning and preparation awaits", async () => {
    const fixture = sqlite();
    const generated = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "byte-length-getter",
      functionRuntime,
    });
    const vm = createNodeVm(refusingVm, runtime, constructors, { learning: generated });
    const prototype = Object.getPrototypeOf(Uint8Array.prototype);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "byteLength")!;
    const define = Object.defineProperty;
    let calls = 0;
    let result: unknown;
    let map: NodeGeneratedCodeModuleMap | undefined;
    try {
      try {
        define(prototype, "byteLength", {
          get() {
            calls++;
            throw new Error("A guest byte-length getter ran");
          },
          configurable: true,
        });
        result = vm.module.compileFunction("return 1")();
        vm.functionConstructors.Function("value", "return value")(17);
        await vm.flushLearning();
        map = await generated.prepare(Number.MAX_SAFE_INTEGER);
      } finally {
        define(prototype, "byteLength", descriptor);
      }
      expect(calls).toBe(0);
      expect(result).toBe(1);
      expect(Object.keys(map!.modules)).toHaveLength(2);
      const loaded = await preload(map!);
      const counted = countedRuntime();
      const warm = createNodeVm(refusingVm, counted.modules, constructors, {
        prepared: loaded.prepared,
      });
      expect(warm.module.compileFunction("return 1")()).toBe(1);
      expect(warm.functionConstructors.Function("value", "return value")(17)).toBe(17);
      expect(loaded.count()).toBe(2);
      expect(counted.count()).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it("observes rejected learners and concurrent flushes without inherited array setters", async () => {
    const result = await isolatedLearningScenario<{
      hooks: number;
      first: boolean;
      next: boolean;
      shared: boolean;
    }>(`
      const {createNodeVm} = module.exports;
      const first = Promise.withResolvers();
      const second = Promise.withResolvers();
      const third = Promise.withResolvers();
      const failures = [new Error('first learner'),new Error('second learner'),new Error('third learner'),new Error('sync learner')];
      let writes = 0;
      const vm = createNodeVm(refusingVm,runtime,constructors,{learning:{learnFunction(){
        writes++;
        if(writes === 1)return first.promise;
        if(writes === 2)return second.promise;
        if(writes === 3)return third.promise;
        throw failures[3];
      }}});
      const define = Object.defineProperty;
      const descriptor = Object.getOwnPropertyDescriptor(Array.prototype,'0');
      let hooks = 0;
      let firstError,nextError,shared;
      try {
        define(Array.prototype,'0',{set(){hooks++;},configurable:true});
        vm.module.compileFunction('return 1');
        const pending = vm.flushLearning();
        vm.module.compileFunction('return 2');
        shared = vm.flushLearning() === pending;
        first.reject(failures[0]);second.reject(failures[1]);
        firstError = await pending.then(() => undefined,error => error);
        vm.module.compileFunction('return 3');
        vm.module.compileFunction('return 4');
        const next = vm.flushLearning();
        third.reject(failures[2]);
        nextError = await next.then(() => undefined,error => error);
      } finally {
        if(descriptor)define(Array.prototype,'0',descriptor);else delete Array.prototype[0];
      }
      return {hooks,shared,
        first:firstError?.errors.length === 2 && firstError.errors[0] === failures[0] && firstError.errors[1] === failures[1],
        next:nextError?.errors.length === 2 && nextError.errors[0] === failures[3] && nextError.errors[1] === failures[2]};
    `);
    expect(result).toEqual({ hooks: 0, shared: true, first: true, next: true });
  });

  it("preserves retained rows when preparation helpers change before or during awaits", async () => {
    const fixture = sqlite();
    try {
      const result = await isolatedLearningScenario<{
        hooks: number;
        survived: number;
        nullRoots: boolean;
      }>(
        `
        const {createNodeGeneratedCode} = module.exports;
        let chunkRead;
        const observedStorage = {
          sql:{databaseSize:storage.sql.databaseSize,exec(query,...bindings){
            const result = storage.sql.exec(query,...bindings);
            if(chunkRead && query.includes('FROM node_generated_code_chunk_v1')){const notify=chunkRead;chunkRead=undefined;notify();}
            return result;
          }},
          transactionSync:callback => storage.transactionSync(callback),
        };
        const generated = createNodeGeneratedCode({storage:observedStorage,scopeId:'prepare-hooks',functionRuntime});
        await generated.learnFunction({kind:'function',params:[],body:'return 1'});
        await generated.learnFunction({kind:'function',params:[],body:'return 2'});
        const original = await generated.prepare(1048576);
        const keys = Object.keys(original.modules).sort().join(',');
        const define = Object.defineProperty;
        const own = Object.getOwnPropertyDescriptor;
        const prototypeOf = Object.getPrototypeOf;
        const from = own(Array,'from');
        const then = own(Object.prototype,'then');
        let hooks = 0;
        let survived = 0;
        let nullRoots = prototypeOf(original) === null;
        const replacement = () => {hooks++;return [];};
        const getter = () => {hooks++;throw new Error('Inherited prepared-result then was read');};
        for(let index=0;index<6;index++){
          let pending;
          try {
            if(index >= 4){
              const read = Promise.withResolvers();chunkRead=read.resolve;
              pending = generated.prepare(1048576);
              await read.promise;
            }else if(index >= 2)pending = generated.prepare(1048576);
            if(index % 2 === 0)define(Array,'from',{value:replacement,writable:true,configurable:true});
            else define(Object.prototype,'then',{get:getter,configurable:true});
            const prepared = await (pending ?? generated.prepare(1048576));
            nullRoots = nullRoots && prototypeOf(prepared) === null;
            if(countRows() !== 2)throw new Error('Preparation deleted retained rows');
          } finally {
            define(Array,'from',from);
            if(then)define(Object.prototype,'then',then);else delete Object.prototype.then;
          }
          const recovered = await generated.prepare(1048576);
          if(Object.keys(recovered.modules).sort().join(',') !== keys)throw new Error('Retained source did not recover');
          survived++;
        }
        return {hooks,survived,nullRoots};
      `,
        {
          storage: fixture.storage,
          countRows: () =>
            fixture.database
              .prepare(
                "SELECT count(*) AS n FROM node_generated_code_retention_v1 WHERE scope_id = 'prepare-hooks'",
              )
              .get()!.n,
        },
      );
      expect(result).toEqual({ hooks: 0, survived: 6, nullRoots: true });
    } finally {
      fixture.close();
    }
  });

  it("never reads guest Promise constructor, then or species hooks through flush and preparation", async () => {
    const bundle = await Esbuild.build({
      stdin: {
        contents:
          'export {createNodeGeneratedCode} from "./NodeGeneratedCode.ts"; export {createNodeVm} from "./NodeVm.ts";',
        resolveDir: new URL("../", import.meta.url).pathname,
      },
      bundle: true,
      platform: "node",
      packages: "external",
      format: "cjs",
      write: false,
    });
    const fixture = sqlite();
    const completed = Promise.withResolvers<{
      calls: number;
      retained: number;
      recovered: number;
      error?: string;
    }>();
    const sandbox = {
      module: { exports: {} },
      require: NodeModule.createRequire(import.meta.url),
      crypto: globalThis.crypto,
      TextEncoder,
      storage: fixture.storage,
      functionRuntime,
      runtime,
      constructors,
      refusingVm,
      done: completed.resolve,
    };
    const context = NodeVM.createContext(sandbox);
    try {
      NodeVM.runInContext(bundle.outputFiles![0]!.text, context);
      // The altered Promise realm is separate from the test runner. Its hooks stay
      // installed across every real hash/flush/prepare await, and restore only in finally.
      NodeVM.runInContext(
        `void (async () => {
        const {createNodeGeneratedCode, createNodeVm} = module.exports;
        const generated = createNodeGeneratedCode({storage,scopeId:'promise-hooks',functionRuntime});
        const vm = createNodeVm(refusingVm,runtime,constructors,{learning:generated});
        const define = Object.defineProperty;
        const own = Object.getOwnPropertyDescriptor;
        const apply = Reflect.apply;
        const nativeThen = Promise.prototype.then;
        const targets = [Promise.prototype,Promise.prototype,Promise];
        const names = ['constructor','then',Symbol.species];
        const originals = targets.map((target,index) => own(target,names[index]));
        let calls = 0;
        let retained = 0;
        try {
          vm.module.compileFunction('return 1')();
          await vm.flushLearning();
          const original = await generated.prepare(1048576);
          const originalKey = Object.keys(original.modules)[0];
          const fail = () => {calls++;throw new Error('Guest Promise hook ran');};
          const forge = function(ok,error) {
            calls++;
            return apply(nativeThen,this,[() => ok('forged'),error]);
          };
          for (let index = 0; index < 4; index++) {
            try {
              if (index === 0) define(Promise.prototype,'constructor',{get:fail,configurable:true});
              if (index === 1) define(Promise.prototype,'then',{value:forge,writable:true,configurable:true});
              if (index === 2) define(Promise,Symbol.species,{get:fail,configurable:true});
              if (index === 3) {
                define(Promise.prototype,'constructor',{value:function X(){},writable:true,configurable:true});
                define(Promise.prototype,'then',{value:forge,writable:true,configurable:true});
                define(Promise,Symbol.species,{get:fail,configurable:true});
              }
              if (vm.module.compileFunction('return 2')() !== 2) throw new Error('Compilation changed');
              await vm.flushLearning();
              const staged = await generated.prepare(1048576);
              retained = Object.keys(staged.modules).length;
              if (retained !== 1 || staged.modules[originalKey] !== original.modules[originalKey]) {
                throw new Error('Guest Promise hooks corrupted retained source or its key');
              }
            } finally {
              for (let field = 0; field < targets.length; field++) define(targets[field],names[field],originals[field]);
            }
          }
          vm.module.compileFunction('return 2')();
          await vm.flushLearning();
          const recovered = Object.keys((await generated.prepare(1048576)).modules).length;
          done({calls,retained,recovered});
        } catch(error) {
          done({calls,retained,recovered:0,error:String(error)+'\\n'+error.stack});
        }
      })();`,
        context,
      );
      expect(await completed.promise).toEqual({ calls: 0, retained: 1, recovered: 2 });
    } finally {
      fixture.close();
    }
  });

  it("rechecks the realm after source hashing before writing chunks or retention", async () => {
    const fixture = sqlite();
    const built = Promise.withResolvers<void>();
    const generated = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "second-await",
      functionRuntime: {
        runtimeFunctionModule(...input) {
          const source = functionRuntime.runtimeFunctionModule(...input);
          built.resolve();
          return source;
        },
      },
    });
    const vm = createNodeVm(refusingVm, runtime, constructors, { learning: generated });
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "push")!;
    const define = Object.defineProperty;
    let calls = 0;
    try {
      expect(vm.module.compileFunction("return 1")()).toBe(1);
      await built.promise;
      try {
        define(Array.prototype, "push", {
          value() {
            calls++;
            throw new Error("Chunking invoked a hook installed during hashing");
          },
          writable: true,
          configurable: true,
        });
        await vm.flushLearning();
      } finally {
        define(Array.prototype, "push", descriptor);
      }
      expect(calls).toBe(0);
      expect(Object.keys((await generated.prepare(Number.MAX_SAFE_INTEGER)).modules)).toHaveLength(
        0,
      );
      vm.module.compileFunction("return 1");
      await vm.flushLearning();
      expect(Object.keys((await generated.prepare(Number.MAX_SAFE_INTEGER)).modules)).toHaveLength(
        1,
      );
    } finally {
      fixture.close();
    }
  });

  it("drains pending persistence and reports asynchronous and synchronous failures without changing results", async () => {
    const task = Promise.withResolvers<unknown>();
    const asynchronous = new Error("sqlite failed");
    const synchronous = new Error("learning threw");
    let calls = 0;
    const vm = createNodeVm(refusingVm, runtime, constructors, {
      learning: {
        learnFunction() {
          if (++calls === 1) return task.promise;
          throw synchronous;
        },
      },
    });
    expect(vm.functionConstructors.Function("return 3")()).toBe(3);
    expect(vm.module.compileFunction("return 5")()).toBe(5);
    const flush = vm.flushLearning();
    expect(vm.flushLearning()).toBe(flush);
    const rejection = expect(flush).rejects.toMatchObject({ errors: [synchronous, asynchronous] });
    task.reject(asynchronous);
    await rejection;
    await expect(vm.flushLearning()).resolves.toBeUndefined();
  });

  it("keeps native success and an undefined learning option unchanged", async () => {
    let learned = 0;
    const native = () => 17;
    const vm = createNodeVm(
      { runInThisContext: () => "native", compileFunction: () => native },
      runtime,
      undefined,
      {
        learning: {
          async learnFunction() {
            learned++;
          },
        },
      },
    );
    expect(vm.module.compileFunction("ignored")).toBe(native);
    expect(vm.module.runInThisContext("ignored")).toBe("native");
    await vm.flushLearning();
    expect(learned).toBe(0);
    const plain = createNodeVm(refusingVm, runtime, constructors);
    expect(plain.functionConstructors.Function("return 19")()).toBe(19);
    await plain.flushLearning();
  });

  it("keeps free CJS reads and writes live, including escaped identifiers and older staged entries", async () => {
    const fixture = sqlite();
    const generated = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "live-cjs",
      functionRuntime,
    });
    const names = ["require", "module", "exports", "__filename", "__dirname"];
    const previous = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
    const sources = names.map((name) => ({
      kind: "function" as const,
      params: [],
      body: `return ${name}`,
    }));
    try {
      // An old cache can contain the unsafe pinned factories. Lookup must refuse them too.
      for (const entry of sources) await generated.learnFunction(entry);
      const stale = await preload(await generated.prepare(Number.MAX_SAFE_INTEGER));
      const counted = countedRuntime();
      const vm = createNodeVm(refusingVm, counted.modules, constructors, {
        learning: generated,
        prepared: stale.prepared,
      });
      for (const name of names) {
        Object.defineProperty(globalThis, name, { value: 1, configurable: true, writable: true });
        const read = vm.module.compileFunction(`return ${name}`);
        const escaped = vm.functionConstructors.Function(
          `return \\u${name.charCodeAt(0).toString(16).padStart(4, "0")}${name.slice(1)}`,
        );
        const nested = vm.functionConstructors.Function(`return () => ${name}`)();
        Reflect.set(globalThis, name, 2);
        expect(read()).toBe(2);
        expect(escaped()).toBe(2);
        expect(nested()).toBe(2);
        const write = vm.functionConstructors.Function(`${name} = 3`);
        write();
        expect(Reflect.get(globalThis, name)).toBe(3);
      }
      await vm.flushLearning();
      expect(counted.count()).toBe(20);
      expect(stale.count()).toBe(0);
      expect(Object.keys((await generated.prepare(Number.MAX_SAFE_INTEGER)).modules)).toHaveLength(
        5,
      );
      // A new scope must retain none of the affected functions.
      const fresh = createNodeGeneratedCode({
        storage: fixture.storage,
        scopeId: "fresh-cjs",
        functionRuntime,
      });
      const freshVm = createNodeVm(refusingVm, runtime, constructors, { learning: fresh });
      for (const entry of sources) freshVm.module.compileFunction(entry.body);
      await freshVm.flushLearning();
      expect((await fresh.prepare(Number.MAX_SAFE_INTEGER)).modules).toEqual({});
    } finally {
      names.forEach((name, index) => {
        const descriptor = previous[index];
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      });
      fixture.close();
    }
  });

  it("stages local CJS bindings while ignoring property keys and string literals", async () => {
    const fixture = sqlite();
    const generated = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "shadowed",
      functionRuntime,
    });
    const cold = createNodeVm(refusingVm, runtime, constructors, { learning: generated });
    const run = (vm: ReturnType<typeof createNodeVm>) => {
      expect(vm.functionConstructors.Function("require", "return () => require")(71)()).toBe(71);
      expect(vm.module.compileFunction("let module = 1; module = 2; return module")()).toBe(2);
      expect(
        vm.module.compileFunction("return ({require: 'exports', __filename: 3}).__filename")(),
      ).toBe(3);
      expect(vm.module.compileFunction("let \\u0065xports = 5; return exports")()).toBe(5);
    };
    try {
      run(cold);
      await cold.flushLearning();
      const map = await generated.prepare(Number.MAX_SAFE_INTEGER);
      expect(Object.keys(map.modules)).toHaveLength(4);
      const loaded = await preload(map);
      const counted = countedRuntime();
      run(createNodeVm(refusingVm, counted.modules, constructors, { prepared: loaded.prepared }));
      expect(loaded.count()).toBe(4);
      expect(counted.count()).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it("covers a queued write after an empty flush without a microtask gap", async () => {
    const write = Promise.withResolvers<unknown>();
    const vm = createNodeVm(refusingVm, runtime, constructors, {
      learning: { learnFunction: () => write.promise },
    });
    const empty = vm.flushLearning();
    expect(vm.module.compileFunction("return 101")()).toBe(101);
    const next = vm.flushLearning();
    let settled = false;
    const observed = next.then(() => {
      settled = true;
    });
    await empty;
    expect(settled).toBe(false);
    write.resolve(undefined);
    await observed;
    expect(settled).toBe(true);
  });

  it("rechecks own and inherited CJS accessors before every staged construction without invoking them", async () => {
    const fixture = sqlite();
    const generated = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "accessors",
      functionRuntime,
    });
    const cold = createNodeVm(refusingVm, runtime, constructors, { learning: generated });
    cold.module.compileFunction("return 1");
    await cold.flushLearning();
    const loaded = await preload(await generated.prepare(Number.MAX_SAFE_INTEGER));
    const counted = countedRuntime();
    const warm = createNodeVm(refusingVm, counted.modules, constructors, {
      prepared: loaded.prepared,
    });
    const names = ["require", "module", "exports", "__filename", "__dirname"];
    const previous = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
    const previousPrototype = Object.getPrototypeOf(globalThis);
    const inherited = Object.create(previousPrototype);
    let getterReads = 0;
    const getter = () => {
      getterReads++;
      throw new Error("An unrelated global accessor was invoked");
    };
    try {
      expect(warm.module.compileFunction("return 1")()).toBe(1);
      Object.setPrototypeOf(globalThis, inherited);
      for (const name of names) {
        Object.defineProperty(globalThis, name, { get: getter, configurable: true });
        expect(cold.functionConstructors.Function("return 1")()).toBe(1);
        expect(warm.functionConstructors.Function("return 1")()).toBe(1);
        Object.defineProperty(globalThis, name, { value: 7, writable: true, configurable: true });
        expect(warm.module.compileFunction("return 1")()).toBe(1);
        Reflect.deleteProperty(globalThis, name);
        Object.defineProperty(inherited, name, { get: getter, configurable: true });
        expect(warm.module.compileFunction("return 1")()).toBe(1);
        Object.defineProperty(globalThis, name, { value: 11, writable: true, configurable: true });
        expect(warm.functionConstructors.Function("return 1")()).toBe(1);
      }
      expect(getterReads).toBe(0);
      expect(counted.count()).toBe(10);
      expect(loaded.count()).toBe(11);
    } finally {
      Object.setPrototypeOf(globalThis, previousPrototype);
      names.forEach((name, index) => {
        const descriptor = previous[index];
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      });
      await cold.flushLearning();
      fixture.close();
    }
  });

  it("interprets replaced globalThis bindings without reading accessors or Proxy traps", async () => {
    const fixture = sqlite();
    const generated = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "global-binding",
      functionRuntime,
    });
    const cold = createNodeVm(refusingVm, runtime, constructors, { learning: generated });
    cold.module.compileFunction("return 1");
    await cold.flushLearning();
    const loaded = await preload(await generated.prepare(Number.MAX_SAFE_INTEGER));
    const counted = countedRuntime();
    const warm = createNodeVm(refusingVm, counted.modules, constructors, {
      prepared: loaded.prepared,
    });
    const root = globalThis;
    const define = Object.defineProperty;
    const previous = Object.getOwnPropertyDescriptor(root, "globalThis")!;
    let reads = 0;
    const unexpected = () => {
      reads++;
      throw new Error("Global binding inspection invoked guest code");
    };
    const decoy = Object.create(null, { require: { get: unexpected } });
    const proxy = new Proxy(
      {},
      { get: unexpected, getOwnPropertyDescriptor: unexpected, getPrototypeOf: unexpected },
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const results: unknown[] = [];
    try {
      for (const value of [null, decoy, proxy, revoked.proxy]) {
        define(root, "globalThis", { value, writable: true, configurable: true });
        results.push(cold.functionConstructors.Function("return 1")());
        results.push(warm.module.compileFunction("return 1")());
      }
      define(root, "globalThis", { get: unexpected, configurable: true });
      results.push(cold.module.compileFunction("return 1")());
      results.push(warm.functionConstructors.Function("return 1")());
    } finally {
      define(root, "globalThis", previous);
      await cold.flushLearning();
      fixture.close();
    }
    expect(results).toEqual(Array(10).fill(1));
    expect(reads).toBe(0);
    expect(counted.count()).toBe(5);
    expect(loaded.count()).toBe(0);
    expect(warm.module.compileFunction("return 1")()).toBe(1);
    expect(loaded.count()).toBe(1);
  });

  it("rejects Proxy nodes before inspecting the global prototype chain, including revoked proxies", async () => {
    const fixture = sqlite();
    const generated = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "proxy-chain",
      functionRuntime,
    });
    const cold = createNodeVm(refusingVm, runtime, constructors, { learning: generated });
    cold.module.compileFunction("return 1");
    await cold.flushLearning();
    const loaded = await preload(await generated.prepare(Number.MAX_SAFE_INTEGER));
    const counted = countedRuntime();
    const warm = createNodeVm(refusingVm, counted.modules, constructors, {
      prepared: loaded.prepared,
    });
    const root = globalThis;
    const inherited = Object.getPrototypeOf(root);
    const previousPrototype = Object.getPrototypeOf(inherited);
    const names = ["require", "module", "exports", "__filename", "__dirname"];
    const previous = names.map((name) => Object.getOwnPropertyDescriptor(root, name));
    const previousInherited = names.map((name) => Object.getOwnPropertyDescriptor(inherited, name));
    let traps = 0;
    const unexpected = () => {
      traps++;
      throw new Error("A global prototype Proxy trap ran");
    };
    const target = Object.create(previousPrototype);
    const proxy = new Proxy(target, {
      get: unexpected,
      getOwnPropertyDescriptor: unexpected,
      getPrototypeOf: unexpected,
    });
    const revoked = Proxy.revocable(target, {});
    revoked.revoke();
    const results: unknown[] = [];
    try {
      for (const name of names) {
        Reflect.deleteProperty(root, name);
        Reflect.deleteProperty(inherited, name);
      }
      for (const prototype of [proxy, Object.create(proxy), revoked.proxy]) {
        Object.setPrototypeOf(inherited, prototype);
        results.push(cold.module.compileFunction("return 1")());
        results.push(warm.functionConstructors.Function("return 1")());
      }
    } finally {
      Object.setPrototypeOf(inherited, previousPrototype);
      names.forEach((name, index) => {
        if (previous[index]) Object.defineProperty(root, name, previous[index]!);
        else Reflect.deleteProperty(root, name);
        if (previousInherited[index])
          Object.defineProperty(inherited, name, previousInherited[index]!);
        else Reflect.deleteProperty(inherited, name);
      });
      await cold.flushLearning();
      fixture.close();
    }
    expect(results).toEqual(Array(6).fill(1));
    expect(traps).toBe(0);
    expect(counted.count()).toBe(3);
    expect(loaded.count()).toBe(0);
    expect(warm.module.compileFunction("return 1")()).toBe(1);
    expect(loaded.count()).toBe(1);
  });

  it("uses captured reflection and native Proxy detection after guest replacements", async () => {
    const fixture = sqlite();
    const generated = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "captured-guards",
      functionRuntime,
    });
    const cold = createNodeVm(refusingVm, runtime, constructors, { learning: generated });
    cold.module.compileFunction("return 1");
    await cold.flushLearning();
    const loaded = await preload(await generated.prepare(Number.MAX_SAFE_INTEGER));
    const counted = countedRuntime();
    const warm = createNodeVm(refusingVm, counted.modules, constructors, {
      prepared: loaded.prepared,
    });
    const root = globalThis;
    const define = Object.defineProperty;
    const own = Object.getOwnPropertyDescriptor;
    const proto = Object.getPrototypeOf;
    const setProto = Object.setPrototypeOf;
    const inherited = proto(root);
    const previousPrototype = proto(inherited);
    const require = own(root, "require");
    const inheritedRequire = own(inherited, "require");
    const replacements = [
      [Object, "getOwnPropertyDescriptor"],
      [Object, "getPrototypeOf"],
      [Object, "hasOwn"],
      [NodeUtil.types, "isProxy"],
    ] as const;
    const descriptors = replacements.map(([target, name]) => own(target, name)!);
    let traps = 0;
    let replacementsCalled = 0;
    const proxy = new Proxy(Object.create(previousPrototype), {
      get() {
        traps++;
        throw new Error("Proxy value was read");
      },
      getOwnPropertyDescriptor() {
        traps++;
        throw new Error("Proxy descriptor was read");
      },
      getPrototypeOf() {
        traps++;
        throw new Error("Proxy prototype was read");
      },
    });
    const results: unknown[] = [];
    try {
      define(root, "require", { value: proxy, configurable: true, writable: true });
      results.push(warm.module.compileFunction("return 1")());
      for (const [target, name] of replacements) {
        define(target, name, {
          value() {
            replacementsCalled++;
            throw new Error("A replacement reflection helper ran");
          },
          configurable: true,
          writable: true,
        });
      }
      results.push(warm.module.compileFunction("return 1")());
      results.push(cold.module.compileFunction("return 1")());
      Reflect.deleteProperty(root, "require");
      Reflect.deleteProperty(inherited, "require");
      setProto(inherited, proxy);
      results.push(warm.functionConstructors.Function("return 1")());
      results.push(cold.functionConstructors.Function("return 1")());
    } finally {
      replacements.forEach(([target, name], index) => define(target, name, descriptors[index]!));
      setProto(inherited, previousPrototype);
      if (require) define(root, "require", require);
      else Reflect.deleteProperty(root, "require");
      if (inheritedRequire) define(inherited, "require", inheritedRequire);
      else Reflect.deleteProperty(inherited, "require");
      await cold.flushLearning();
      fixture.close();
    }
    expect(results).toEqual([1, 1, 1, 1, 1]);
    expect(traps).toBe(0);
    expect(replacementsCalled).toBe(0);
    expect(loaded.count()).toBe(2);
    expect(counted.count()).toBe(1);
  });

  it("keeps free anonymous references global while staging shadowed locals and nested function names", async () => {
    const fixture = sqlite();
    const generated = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "anonymous",
      functionRuntime,
    });
    const cold = createNodeVm(refusingVm, runtime, constructors, { learning: generated });
    const previous = Object.getOwnPropertyDescriptor(globalThis, "anonymous");
    const escaped = "return \\u0061nonymous";
    const unsafe: NodeGeneratedFunctionCode[] = [
      { kind: "function", params: [], body: "return anonymous" },
      { kind: "function", params: [], body: escaped },
      { kind: "function", params: [], body: "return () => anonymous" },
      { kind: "function", params: [], body: "anonymous = 31; return anonymous" },
      { kind: "function", params: ["value = anonymous"], body: "return value" },
      { kind: "async", params: [], body: "return anonymous" },
      { kind: "generator", params: [], body: "yield anonymous" },
      { kind: "asyncGenerator", params: [], body: "yield anonymous" },
    ];
    const run = async (vm: ReturnType<typeof createNodeVm>) => {
      Object.defineProperty(globalThis, "anonymous", {
        value: 23,
        writable: true,
        configurable: true,
      });
      expect(vm.module.compileFunction("return anonymous")()).toBe(23);
      expect(vm.functionConstructors.Function(escaped)()).toBe(23);
      const nested = vm.functionConstructors.Function("return () => anonymous")();
      Reflect.set(globalThis, "anonymous", 29);
      expect(nested()).toBe(29);
      expect(vm.functionConstructors.Function("anonymous = 31; return anonymous")()).toBe(31);
      expect(Reflect.get(globalThis, "anonymous")).toBe(31);
      Reflect.set(globalThis, "anonymous", 23);
      expect(vm.functionConstructors.Function("value = anonymous", "return value")()).toBe(23);
      expect(await vm.functionConstructors.AsyncFunction("return anonymous")()).toBe(23);
      expect(vm.functionConstructors.GeneratorFunction("yield anonymous")().next().value).toBe(23);
      expect(
        (await vm.functionConstructors.AsyncGeneratorFunction("yield anonymous")().next()).value,
      ).toBe(23);
      expect(vm.functionConstructors.Function("anonymous", "return anonymous")(41)).toBe(41);
      expect(vm.module.compileFunction("let anonymous = 43; return () => anonymous")()()).toBe(43);
      expect(vm.module.compileFunction("let \\u0061nonymous = 47; return anonymous")()).toBe(47);
      const local = vm.functionConstructors.Function(
        "return function anonymous() { return anonymous; }",
      )();
      expect(local()).toBe(local);
      expect(vm.module.compileFunction("return ({anonymous: 'anonymous'}).anonymous")()).toBe(
        "anonymous",
      );
    };
    try {
      await run(cold);
      await cold.flushLearning();
      expect(Object.keys((await generated.prepare(Number.MAX_SAFE_INTEGER)).modules)).toHaveLength(
        5,
      );
      // Older retained factories with an incorrect synthetic binding must be ignored too.
      for (const entry of unsafe) await generated.learnFunction(entry);
      const loaded = await preload(await generated.prepare(Number.MAX_SAFE_INTEGER));
      const counted = countedRuntime();
      await run(
        createNodeVm(refusingVm, counted.modules, constructors, { prepared: loaded.prepared }),
      );
      expect(counted.count()).toBe(8);
      expect(loaded.count()).toBe(5);
    } finally {
      if (previous) Object.defineProperty(globalThis, "anonymous", previous);
      else Reflect.deleteProperty(globalThis, "anonymous");
      fixture.close();
    }
  });

  it("reports a synchronous persistence failure queued after an empty flush", async () => {
    const failure = new Error("sync storage failure");
    const vm = createNodeVm(refusingVm, runtime, constructors, {
      learning: {
        learnFunction() {
          throw failure;
        },
      },
    });
    const empty = vm.flushLearning();
    expect(vm.module.compileFunction("return 103")()).toBe(103);
    const rejection = expect(vm.flushLearning()).rejects.toMatchObject({ errors: [failure] });
    await empty;
    await rejection;
  });

  it("keeps execution working when retention skips an oversized generated function", async () => {
    const fixture = sqlite();
    const generated = createNodeGeneratedCode({
      storage: fixture.storage,
      scopeId: "small",
      functionRuntime,
      retention: { maxEntries: 1, maxBytes: 300 },
    });
    const vm = createNodeVm(refusingVm, runtime, constructors, { learning: generated });
    try {
      const value = "x".repeat(500);
      expect(vm.functionConstructors.Function(`return '${value}'`)()).toBe(value);
      await vm.flushLearning();
      expect((await generated.prepare(Number.MAX_SAFE_INTEGER)).modules).toEqual({});
    } finally {
      fixture.close();
    }
  });

  it("stays interpreted and unlearned when prepared scope analysis is unavailable", async () => {
    let learned = 0;
    const { canStageFunction: _analysis, ...withoutAnalysis } = runtime;
    const vm = createNodeVm(refusingVm, withoutAnalysis, constructors, {
      learning: {
        async learnFunction() {
          learned++;
        },
      },
    });
    expect(vm.module.compileFunction("return 113")()).toBe(113);
    await vm.flushLearning();
    expect(learned).toBe(0);
  });

  it("does not retry a staged factory failure or follow inherited factory metadata", async () => {
    const entry = { kind: "function" as const, params: [], body: "return 97" };
    const error = Object.assign(new Error("staged failure"), {
      code: "ERR_METHOD_NOT_IMPLEMENTED",
    });
    let calls = 0;
    let metadataReads = 0;
    const prototype = Object.create(Function.prototype, {
      source: {
        get() {
          metadataReads++;
          throw error;
        },
      },
      unbound: {
        get() {
          metadataReads++;
          throw error;
        },
      },
    });
    const factory = Object.setPrototypeOf(() => {
      calls++;
      throw error;
    }, prototype);
    const counted = countedRuntime();
    const vm = createNodeVm(refusingVm, counted.modules, constructors, {
      prepared: {
        functionIndex: { [nodeGeneratedFunctionSourceKey(entry)]: "gen/staged.js" },
        modules: { "gen/staged.js": factory },
        registerSource,
      },
    });
    expect(() => vm.functionConstructors.Function(entry.body)).toThrow(error);
    expect(calls).toBe(1);
    expect(metadataReads).toBe(0);
    expect(counted.count()).toBe(0);
    await vm.flushLearning();
  });

  it("validates Nimbus source boundaries before a staged factory can execute", async () => {
    const source = functionRuntime.runtimeFunctionModule(
      "function",
      [],
      "}; globalThis.__escape = 1; //",
    );
    const path = NodePath.join(directory, "invalid.cjs");
    await NodeFSP.writeFile(path, source);
    const factory = load(path) as NodeVmPreparedFunctionFactory;
    expect(() => factory(() => Promise.resolve(undefined), undefined)).toThrow(SyntaxError);
    expect(Reflect.get(globalThis, "__escape")).toBeUndefined();
    expect(
      nodeGeneratedFunctionSourceKey({
        kind: "asyncGenerator",
        params: ["a", "b"],
        body: "yield a",
      }),
    ).toBe(JSON.stringify(["asyncGenerator", ["a", "b"], "yield a"]));
  });
});
