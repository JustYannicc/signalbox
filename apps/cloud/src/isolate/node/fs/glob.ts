// @effect-diagnostics nodeBuiltinImport:off - Path and URL helpers are pure; filesystem I/O uses KernelFileSystem.
import type * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { createAsyncOperations } from "./async-operations.ts";
import { readdirSync } from "./directories.ts";
import { lstatSync, realpathSync, statSync } from "./metadata-ops.ts";
import { NodeFsDirentFromStats, type NodeDirentLike } from "./metadata.ts";
import type { AsyncLeafRunner } from "./operations.ts";
import { createNodeGlobModule as createNodeGlobCore } from "./vendor/node/generated/glob-core.ts";
import { createNodeMinimatchModule } from "./vendor/node/generated/glob-matcher.ts";
import type {
  NodeGlobCoreDependencies,
  NodeGlobCoreModule,
  NodeGlobMatcherModule,
} from "./glob-contract.ts";

type NodeGlobOptions = NodeFS.GlobOptions & { followSymlinks?: boolean };
type NodeFsGlob = (
  pattern: string | readonly string[],
  options?: NodeGlobOptions,
) => AsyncIterableIterator<string | NodeDirentLike>;

class NodeGlobInvalidArgType extends TypeError {
  readonly code = "ERR_INVALID_ARG_TYPE";

  constructor(name: string, expected: string | readonly string[], value: unknown) {
    const expectation = typeof expected === "string" ? expected : expected.join(" or ");
    const received =
      value === null
        ? "Received null"
        : Array.isArray(value)
          ? "Received an instance of Array"
          : `Received type ${typeof value}`;
    super(`The "${name}" argument must be of type ${expectation}. ${received}`);
  }
}

function arrayPrototypeMap<T, U>(
  values: T[],
  callback: (value: T, index: number, values: T[]) => U,
): U[] {
  const method = Array.prototype.map;
  return method.call(values, callback) as U[];
}

function arrayPrototypeFlatMap<T, U>(
  values: T[],
  callback: (value: T, index: number, values: T[]) => U | readonly U[],
): U[] {
  const method = Array.prototype.flatMap;
  return method.call(values, callback) as U[];
}

function arrayPrototypeAt<T>(values: readonly T[], index: number): T | undefined {
  const method = Array.prototype.at;
  return method.call(values, index);
}

function arrayPrototypePop<T>(values: T[]): T | undefined {
  const method = Array.prototype.pop;
  return method.call(values);
}

function arrayPrototypePush<T>(values: T[], ...items: T[]): number {
  const method = Array.prototype.push;
  return method.call(values, ...items);
}

function arrayPrototypeSome<T>(
  values: T[],
  callback: (value: T, index: number, values: T[]) => boolean,
): boolean {
  const method = Array.prototype.some;
  return method.call(values, callback);
}

function promisePrototypeThen<T, TResult1 = T, TResult2 = never>(
  promise: Promise<T>,
  onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
  onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
): Promise<TResult1 | TResult2> {
  const method = Promise.prototype.then;
  return method.call(promise, onFulfilled, onRejected) as Promise<TResult1 | TResult2>;
}

function stringPrototypeEndsWith(value: string, search: string, endPosition?: number): boolean {
  const method = String.prototype.endsWith;
  return method.call(value, search, endPosition);
}

function createPrimordials(): Record<string, unknown> {
  return {
    ArrayFrom: Array.from,
    ArrayIsArray: Array.isArray,
    ArrayPrototypeAt: arrayPrototypeAt,
    ArrayPrototypeFlatMap: arrayPrototypeFlatMap,
    ArrayPrototypeMap: arrayPrototypeMap,
    ArrayPrototypePop: arrayPrototypePop,
    ArrayPrototypePush: arrayPrototypePush,
    ArrayPrototypeSome: arrayPrototypeSome,
    Promise,
    PromisePrototypeThen: promisePrototypeThen,
    SafeMap: Map,
    SafeSet: Set,
    StringPrototypeEndsWith: stringPrototypeEndsWith,
  };
}

function invalidArgType(name: string, expected: string | readonly string[], value: unknown): never {
  throw new NodeGlobInvalidArgType(name, expected, value);
}

function validateObject(value: unknown, name: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidArgType(name, "object", value);
  }
}

function validateBoolean(value: unknown, name: string): void {
  if (typeof value !== "boolean") invalidArgType(name, "boolean", value);
}

function validateString(value: unknown, name: string): void {
  if (typeof value !== "string") invalidArgType(name, "string", value);
}

function validateStringArray(value: unknown, name: string): void {
  if (!Array.isArray(value)) invalidArgType(name, "string[]", value);
  for (const [index, item] of value.entries()) validateString(item, `${name}[${index}]`);
}

function createNodeGlobRuntime(
  kernelFs: KernelFileSystem,
  runLeaf?: AsyncLeafRunner,
): NodeGlobCoreModule {
  const operations = createAsyncOperations(kernelFs, runLeaf);
  const pathModule = {
    join: NodePath.posix.join,
    resolve: (...paths: string[]) => NodePath.posix.resolve(kernelFs.cwd, ...paths),
    basename: NodePath.posix.basename,
    isAbsolute: NodePath.posix.isAbsolute,
    dirname: NodePath.posix.dirname,
  };
  const syncFileSystem = {
    lstatSync: (path: string) => lstatSync(kernelFs, path),
    readdirSync: (path: string, options?: { withFileTypes?: boolean }) =>
      readdirSync(kernelFs, path, options),
    realpathSync: (path: string) => realpathSync(kernelFs, path),
    statSync: (path: string) => statSync(kernelFs, path),
  };
  const asyncFileSystem = {
    lstat: (path: string) => operations.lstat(path),
    readdir: (path: string) => operations.readdir(path, { withFileTypes: true }),
    realpath: (path: string) => operations.realpath(path),
    stat: (path: string) => operations.stat(path),
  };
  const validators = {
    validateBoolean,
    validateObject,
    validateString,
    validateStringArray,
  };
  const errors = {
    codes: { ERR_INVALID_ARG_TYPE: NodeGlobInvalidArgType },
    hideStackFrames: <T>(callback: T): T => callback,
  };
  const url = {
    toPathIfFileURL(value: unknown): unknown {
      return value instanceof URL ? NodeURL.fileURLToPath(value) : value;
    },
  };
  const minimatch = createNodeMinimatchModule() as NodeGlobMatcherModule;
  const requiredModules = new Map<string, unknown>([
    ["fs", syncFileSystem],
    ["fs/promises", asyncFileSystem],
    ["path", pathModule],
    [
      "internal/util",
      { kEmptyObject: Object.freeze(Object.create(null)), isWindows: false, isMacOS: false },
    ],
    ["internal/validators", validators],
    [
      "internal/fs/utils",
      {
        DirentFromStats: NodeFsDirentFromStats,
      },
    ],
    ["internal/errors", errors],
    [
      "internal/assert",
      (condition: unknown) => {
        if (!condition) throw new Error("Node glob invariant failed");
      },
    ],
    ["internal/url", url],
    ["internal/deps/minimatch/index", minimatch],
  ]);
  const dependencies: NodeGlobCoreDependencies = {
    require(id) {
      const module = requiredModules.get(id);
      if (module === undefined) throw new Error(`Unsupported Node glob dependency: ${id}`);
      return module;
    },
    primordials: createPrimordials(),
    platform: "linux",
  };
  return createNodeGlobCore(dependencies) as NodeGlobCoreModule;
}

export function createNodeFsGlob(
  kernelFs: KernelFileSystem,
  runLeaf?: AsyncLeafRunner,
): NodeFsGlob {
  const module = createNodeGlobRuntime(kernelFs, runLeaf);
  return async function* glob(pattern, options) {
    yield* new module.Glob(pattern, options).glob() as AsyncIterableIterator<
      string | NodeDirentLike
    >;
  };
}
