// @effect-diagnostics nodeBuiltinImport:off - use native scheduling and clocks; host authority stays explicit.
import * as NodeEvents from "node:events";
import * as NodeProcess from "node:process";

import { validateNodeProcessHost, type NodeProcessHostContext } from "./node/process/context.ts";
import { unsupportedNodeOperation } from "./node/process/NodeError.ts";
import { nodeProcessSignalError, normalizeNodeSignal } from "./node/process/signals.ts";
import { createCpuUsage } from "./node/process/cpu-usage.ts";
import { createProcessWarnings } from "./node/process/warnings.ts";

/* Adapted from Rivet agentOS's Node process bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * This keeps its exit-event/typed-exit shape while requiring Signalbox host identity and capabilities.
 * Licensed under Apache-2.0; see ./bun/LICENSE.agentos and ./bun/NOTICE.agentos.
 */

export { NodeSystemError } from "./node/process/NodeError.ts";
export type {
  NodeProcessEnvironment,
  NodeProcessFileSystem,
  NodeProcessHostContext,
  NodeProcessStreams,
  NodeRuntimeIdentity,
  NodeRuntimeUserIdentity,
} from "./node/process/context.ts";

export class NodeProcessExitError extends Error {
  readonly code: number;

  constructor(code: number, cause?: unknown) {
    super(`process.exit(${code})`, cause === undefined ? undefined : { cause });
    this.name = "NodeProcessExitError";
    this.code = code;
  }
}

export type { NodeProcessWarningOptions } from "./node/process/warnings.ts";

export type NodeProcessState = "running" | "exiting" | "exited";

type HrtimeFunction = ((previous?: [number, number]) => [number, number]) & {
  bigint: () => bigint;
};

function createHrtime(readMonotonicTimeNs?: () => bigint): HrtimeFunction {
  const nativeHrtime: unknown = Reflect.get(NodeProcess, "hrtime");
  const nativeBigint: unknown =
    typeof nativeHrtime === "function" ? Reflect.get(nativeHrtime, "bigint") : undefined;
  const hostPerformance = typeof performance === "undefined" ? undefined : performance;
  const performanceNow = hostPerformance ? Reflect.get(hostPerformance, "now") : undefined;
  const monotonicNow =
    readMonotonicTimeNs ??
    (typeof nativeBigint === "function"
      ? () => Reflect.apply(nativeBigint, nativeHrtime, []) as bigint
      : () => {
          if (typeof performanceNow !== "function" || !hostPerformance) {
            return unsupportedNodeOperation("process.hrtime.bigint");
          }
          const milliseconds = Reflect.apply(performanceNow, hostPerformance, []) as number;
          return BigInt(Math.floor(milliseconds * 1e6));
        });
  const hrtime = ((previous?: [number, number]) => {
    const nanoseconds = monotonicNow();
    const seconds = Number(nanoseconds / 1_000_000_000n);
    const remainder = Number(nanoseconds % 1_000_000_000n);
    if (!previous) return [seconds, remainder];
    const difference = nanoseconds - (BigInt(previous[0]) * 1_000_000_000n + BigInt(previous[1]));
    return [Number(difference / 1_000_000_000n), Number(difference % 1_000_000_000n)];
  }) as HrtimeFunction;
  hrtime.bigint = monotonicNow;
  return hrtime;
}

function validateExitCode(code: unknown): number {
  if (typeof code !== "number" || !Number.isInteger(code)) {
    throw new TypeError(`Exit code must be an integer. Received ${String(code)}`);
  }
  if (code < 0 || code > 255) throw new RangeError("Exit code must be between 0 and 255");
  return code;
}

function unsupportedMeasurement(name: string) {
  return (..._args: unknown[]) => unsupportedNodeOperation(`process.${name}`);
}

function unsupportedMemoryUsage() {
  const memoryUsage = unsupportedMeasurement("memoryUsage") as (() => never) & { rss: () => never };
  memoryUsage.rss = unsupportedMeasurement("memoryUsage.rss");
  return memoryUsage;
}

const eventEmitterMethods = [
  "addListener",
  "emit",
  "eventNames",
  "getMaxListeners",
  "listenerCount",
  "listeners",
  "off",
  "on",
  "once",
  "prependListener",
  "prependOnceListener",
  "rawListeners",
  "removeAllListeners",
  "removeListener",
  "setMaxListeners",
] as const;

function exposeOwnBoundMethods(target: object, names: readonly string[]): void {
  const boundByMethod = new Map<(...args: unknown[]) => unknown, (...args: unknown[]) => unknown>();
  for (const name of names) {
    const method: unknown = Reflect.get(target, name);
    if (typeof method !== "function")
      throw new TypeError(`Node process method is unavailable: ${name}`);
    const callable = method as (...args: unknown[]) => unknown;
    let bound = boundByMethod.get(callable);
    if (!bound) {
      bound = (...args: unknown[]) => Reflect.apply(callable, target, args);
      boundByMethod.set(callable, bound);
    }
    // Node's own process methods are plain writable properties. graceful-fs replaces cwd and
    // chdir, and signal-exit replaces emit; a read-only method throws in their strict-mode code.
    Object.defineProperty(target, name, {
      value: bound,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
}

function exposeOwnAccessors(target: object, prototype: object, names: readonly string[]): void {
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor) throw new TypeError(`Node process property is unavailable: ${name}`);
    Object.defineProperty(target, name, { ...descriptor, configurable: false, enumerable: true });
  }
}

class HostProcess extends NodeEvents.EventEmitter {
  readonly env: NodeProcessHostContext["env"];
  readonly argv: string[];
  readonly execArgv: string[];
  readonly argv0: string;
  readonly execPath: string;
  readonly pid: number;
  readonly ppid: number;
  readonly platform: string;
  readonly arch: string;
  readonly version: string;
  readonly versions: Readonly<Record<string, string>>;
  readonly main: unknown;
  readonly mainModule: unknown;
  readonly stdin: NodeProcessHostContext["streams"]["stdin"];
  readonly stdout: NodeProcessHostContext["streams"]["stdout"];
  readonly stderr: NodeProcessHostContext["streams"]["stderr"];
  readonly hrtime: HrtimeFunction;
  readonly emitWarning: ReturnType<typeof createProcessWarnings>;
  readonly #host: NodeProcessHostContext;
  readonly #monotonicNowNs: () => bigint;
  readonly #startTimeNs: bigint;

  #state: NodeProcessState = "running";
  #exitCode: number | undefined;

  constructor(host: NodeProcessHostContext) {
    super();
    this.#host = host;
    this.hrtime = createHrtime(host.monotonicNowNs);
    this.#monotonicNowNs = this.hrtime.bigint;
    this.#startTimeNs = this.#monotonicNowNs();
    this.env = host.env;
    this.argv = [...host.identity.argv];
    this.execArgv = [...(host.identity.execArgv ?? [])];
    this.argv0 = host.identity.argv0;
    this.execPath = host.identity.execPath;
    this.pid = host.identity.pid;
    this.ppid = host.identity.ppid;
    this.platform = host.systemIdentity?.platform ?? host.identity.platform;
    this.arch = host.systemIdentity?.arch ?? host.identity.arch;
    this.version = host.identity.version;
    this.versions = Object.freeze({ ...host.identity.versions });
    this.main = host.identity.main;
    this.mainModule = host.identity.main;
    this.stdin = host.streams.stdin;
    this.stdout = host.streams.stdout;
    this.stderr = host.streams.stderr;
    this.emitWarning = createProcessWarnings(this);

    for (const name of ["_events", "_eventsCount", "_maxListeners"]) {
      const descriptor = Object.getOwnPropertyDescriptor(this, name);
      if (descriptor?.enumerable) {
        Object.defineProperty(this, name, { ...descriptor, enumerable: false });
      }
    }
    // The bridge's CJS-to-ESM conversion copies enumerable own exports, not prototype methods.
    exposeOwnBoundMethods(this, [
      ...eventEmitterMethods,
      "cwd",
      "chdir",
      "nextTick",
      "emitWarning",
      "exit",
      "kill",
    ]);
    exposeOwnAccessors(this, HostProcess.prototype, ["exitCode", "state"]);
  }

  get state(): NodeProcessState {
    return this.#state;
  }

  get exitCode(): number | undefined {
    return this.#exitCode;
  }

  set exitCode(code: number | undefined) {
    if (this.#state !== "running")
      throw new Error("Cannot change exitCode after process exit has started");
    this.#exitCode = code === undefined ? undefined : validateExitCode(code);
  }

  cwd(): string {
    return this.#host.filesystem.cwd;
  }

  chdir(directory: string): void {
    this.#host.filesystem.chdir(directory);
  }

  nextTick<Args extends unknown[]>(callback: (...args: Args) => void, ...args: Args): void {
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    const nativeNextTick: unknown = Reflect.get(NodeProcess, "nextTick");
    if (typeof nativeNextTick === "function") {
      (nativeNextTick as (callback: (...args: Args) => void, ...args: Args) => void)(
        callback,
        ...args,
      );
      return;
    }
    queueMicrotask(() => callback(...args));
  }

  exit(code?: number): never {
    const exitCode = code === undefined ? (this.#exitCode ?? 0) : validateExitCode(code);
    this.#exitCode = exitCode;
    let cause: unknown;
    if (this.#state === "running") {
      this.#state = "exiting";
      try {
        this.emit("exit", exitCode);
      } catch (error) {
        cause = error;
      } finally {
        this.#state = "exited";
      }
    }
    throw new NodeProcessExitError(exitCode, cause);
  }

  kill(pid: number, signal?: string | number): true {
    if (!Number.isSafeInteger(pid)) {
      throw new TypeError(`The "pid" argument must be an integer. Received ${String(pid)}`);
    }
    if (this.#state !== "running")
      throw new Error("Cannot signal a process after exit has started");
    const normalizedSignal = normalizeNodeSignal(signal);
    if (!this.#host.processes) {
      return unsupportedNodeOperation("process.kill host integration");
    }
    const result = this.#host.processes.signalPid(
      this.#host.parentProcessHandle,
      pid,
      normalizedSignal,
    );
    if (result.status !== "ok") throw nodeProcessSignalError(result);
    return true;
  }

  memoryUsage = unsupportedMemoryUsage();
  // Logical user/syscall time uses the kernel's clock resolution; Cloudflare advances it at I/O.
  cpuUsage = createCpuUsage(() => this.#host.cpuAccounting?.snapshot());
  resourceUsage = unsupportedMeasurement("resourceUsage");
  getActiveResourcesInfo = unsupportedMeasurement("getActiveResourcesInfo");
  availableMemory = unsupportedMeasurement("availableMemory");
  constrainedMemory = unsupportedMeasurement("constrainedMemory");
  uptime = () => Number(this.#monotonicNowNs() - this.#startTimeNs) / 1_000_000_000;
}

export function createNodeProcess(host: NodeProcessHostContext) {
  validateNodeProcessHost(host);
  return new HostProcess(host);
}

export default createNodeProcess;
