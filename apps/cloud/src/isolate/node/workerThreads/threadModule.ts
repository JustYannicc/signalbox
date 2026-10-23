import type * as NodeEvents from "node:events";
import type * as NodeStream from "node:stream";

import { NodeWorkerMessagePort } from "./ports.ts";
import { NodeWorkerPorts } from "./portRuntime.ts";
import type {
  NodeWorkerEntry,
  NodeWorkerModuleLoader,
  NodeWorkerStartRequest,
  NodeWorkerThreadContext,
} from "./workerProtocol.ts";

export const SHARE_ENV = Symbol("worker_threads.SHARE_ENV");

export interface NodeWorkerOptions {
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>> | typeof SHARE_ENV;
  readonly eval?: boolean;
  readonly execArgv?: readonly string[];
  readonly name?: string;
  readonly resourceLimits?: NodeWorkerThreadContext["resourceLimits"];
  readonly stderr?: boolean;
  readonly stdin?: boolean;
  readonly stdout?: boolean;
  readonly transferList?: readonly object[];
  readonly workerData?: unknown;
  readonly [option: string]: unknown;
}

export interface NodeWorkerInstance extends NodeEvents.EventEmitter {
  readonly stdin: NodeStream.Writable | null;
  readonly stdout: NodeStream.PassThrough | null;
  readonly stderr: NodeStream.PassThrough | null;
  readonly threadId: number;
  postMessage(value: unknown, transferList?: readonly object[]): void;
  ref(): this;
  unref(): this;
  terminate(): Promise<number>;
  startCpuProfile(...args: readonly unknown[]): never;
  startHeapProfile(...args: readonly unknown[]): never;
  getHeapSnapshot(...args: readonly unknown[]): never;
  cpuUsage(...args: readonly unknown[]): never;
}

export interface NodeWorkerConstructor {
  readonly prototype: NodeWorkerInstance;
  new (filename: string | URL, options?: NodeWorkerOptions): NodeWorkerInstance;
}

export interface ParsedNodeWorkerOptions {
  readonly entry: NodeWorkerEntry;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly execArgv: readonly string[];
  readonly name: string;
  readonly resourceLimits: NonNullable<NodeWorkerStartRequest["resourceLimits"]>;
  readonly stdin: boolean;
  readonly stdout: boolean;
  readonly stderr: boolean;
  readonly transferList: readonly object[];
  readonly workerData: unknown;
}

const supportedOptions = new Set([
  "argv",
  "env",
  "eval",
  "execArgv",
  "name",
  "resourceLimits",
  "stderr",
  "stdin",
  "stdout",
  "transferList",
  "workerData",
]);

function optionsError(message: string): TypeError {
  return new TypeError(`Worker options ${message}`);
}

function stringList(value: unknown, name: string, fallback: readonly string[]): readonly string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw optionsError(`${name} must be an array of strings`);
  return [...value];
}

function booleanOption(options: NodeWorkerOptions, key: "stdin" | "stdout" | "stderr"): boolean {
  const value = options[key];
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw optionsError(`${key} must be a boolean`);
  return value;
}

function parseResourceLimits(
  value: unknown,
  fallback: NodeWorkerThreadContext["resourceLimits"],
): NonNullable<NodeWorkerStartRequest["resourceLimits"]> {
  if (value === undefined) return { ...fallback };
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw optionsError("resourceLimits must be an object");
  const allowed = new Set([
    "maxYoungGenerationSizeMb",
    "maxOldGenerationSizeMb",
    "codeRangeSizeMb",
    "stackSizeMb",
  ]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key))
      throw optionsError(`resourceLimits.${String(key)} is unsupported`);
    const number = Reflect.get(value, key);
    if (typeof number !== "number" || !Number.isFinite(number) || number <= 0)
      throw optionsError(`resourceLimits.${key} must be a positive finite number`);
  }
  return { ...value } as NonNullable<NodeWorkerStartRequest["resourceLimits"]>;
}

function parseEnvironment(
  value: unknown,
  fallback: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (value === undefined) return { ...fallback };
  if (value === SHARE_ENV) {
    const error = new Error("worker_threads.SHARE_ENV is not supported by this runtime");
    Object.assign(error, { code: "ERR_WORKER_UNSUPPORTED_OPERATION" });
    throw error;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw optionsError("env must be an object or SHARE_ENV");
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (typeof entry !== "string") throw optionsError(`env.${key} must be a string`);
    result[key] = entry;
  }
  return result;
}

export function parseWorkerOptions(
  filename: string | URL,
  options: NodeWorkerOptions | undefined,
  moduleLoader: NodeWorkerModuleLoader,
  context: NodeWorkerThreadContext,
): ParsedNodeWorkerOptions {
  if (
    options !== undefined &&
    (options === null || typeof options !== "object" || Array.isArray(options))
  )
    throw optionsError("must be an object");
  const workerOptions = options ?? {};
  for (const key of Reflect.ownKeys(workerOptions)) {
    if (typeof key !== "string" || !supportedOptions.has(key)) {
      const name = String(key);
      if (name === "trackUnmanagedFds")
        throw new Error("worker_threads trackUnmanagedFds is not supported by this runtime");
      throw optionsError(`${name} is unsupported`);
    }
  }
  if (workerOptions.eval !== undefined && typeof workerOptions.eval !== "boolean")
    throw optionsError("eval must be a boolean");
  if (workerOptions.name !== undefined && typeof workerOptions.name !== "string")
    throw optionsError("name must be a string");
  if (workerOptions.transferList !== undefined && !Array.isArray(workerOptions.transferList))
    throw optionsError("transferList must be an array");

  const isEval = workerOptions.eval === true;
  let entry: NodeWorkerEntry;
  if (isEval) {
    if (typeof filename !== "string") throw optionsError("eval requires a source string");
    entry = { kind: "eval", source: filename };
  } else {
    if (typeof filename !== "string" && !(filename instanceof URL))
      throw new TypeError("The worker filename must be a string or file URL");
    if (filename instanceof URL && filename.protocol !== "file:")
      throw new TypeError(
        `Worker URL protocol ${filename.protocol} is unsupported; expected file:`,
      );
    entry = { kind: "file", url: moduleLoader.resolve(filename) };
  }

  return {
    entry,
    argv: stringList(workerOptions.argv, "argv", []),
    env: parseEnvironment(workerOptions.env, context.env),
    execArgv: stringList(workerOptions.execArgv, "execArgv", context.execArgv),
    name: workerOptions.name ?? "",
    resourceLimits: parseResourceLimits(workerOptions.resourceLimits, context.resourceLimits),
    stdin: booleanOption(workerOptions, "stdin"),
    stdout: booleanOption(workerOptions, "stdout"),
    stderr: booleanOption(workerOptions, "stderr"),
    transferList: [...(workerOptions.transferList ?? [])],
    workerData: workerOptions.workerData,
  };
}

export interface NodeWorkerThreadsModule {
  readonly Worker: NodeWorkerConstructor;
  readonly MessageChannel: new () => {
    readonly port1: NodeWorkerMessagePort;
    readonly port2: NodeWorkerMessagePort;
  };
  readonly MessagePort: typeof NodeWorkerMessagePort;
  readonly SHARE_ENV: typeof SHARE_ENV;
  readonly isMainThread: boolean;
  readonly parentPort: NodeWorkerMessagePort | null;
  readonly resourceLimits: NodeWorkerThreadContext["resourceLimits"];
  readonly threadId: number;
  readonly workerData: unknown;
  getEnvironmentData(key: unknown): unknown;
  setEnvironmentData(key: unknown, value: unknown): void;
  receiveMessageOnPort(..._args: readonly unknown[]): never;
  moveMessagePortToContext(..._args: readonly unknown[]): never;
}

export function cloneEnvironmentData(
  ports: NodeWorkerPorts,
  environmentData: ReadonlyMap<unknown, unknown>,
): ReturnType<NodeWorkerPorts["encode"]> {
  return ports.encode([...environmentData.entries()]);
}

export function createThreadModule(
  Worker: NodeWorkerConstructor,
  ports: NodeWorkerPorts,
  context: NodeWorkerThreadContext,
  environmentData: Map<unknown, unknown>,
): NodeWorkerThreadsModule {
  class MessageChannel {
    readonly port1: NodeWorkerMessagePort;
    readonly port2: NodeWorkerMessagePort;

    constructor() {
      const channel = ports.channel();
      this.port1 = channel.port1;
      this.port2 = channel.port2;
    }
  }

  const parentPort = context.parentPort === undefined ? null : ports.adopt(context.parentPort);

  return Object.freeze({
    Worker,
    MessageChannel,
    MessagePort: NodeWorkerMessagePort,
    SHARE_ENV,
    isMainThread: context.isMainThread,
    parentPort,
    resourceLimits: context.resourceLimits,
    threadId: context.threadId,
    workerData: context.workerData,
    getEnvironmentData(key: unknown): unknown {
      return environmentData.get(key);
    },
    setEnvironmentData(key: unknown, value: unknown): void {
      environmentData.set(key, value);
    },
    receiveMessageOnPort: unsupported("receiveMessageOnPort"),
    moveMessagePortToContext: unsupported("moveMessagePortToContext"),
  });
}

export function unsupported(name: string): (...args: readonly unknown[]) => never {
  return (..._args) => {
    const error = new Error(`worker_threads.${name} is not supported by this runtime`);
    Object.assign(error, { code: "ERR_WORKER_UNSUPPORTED_OPERATION" });
    throw error;
  };
}
