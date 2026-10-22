// @effect-diagnostics nodeBuiltinImport:off - use native scheduling and clocks; host authority stays explicit.
import * as NodeEvents from "node:events";
import * as NodeProcess from "node:process";

import {
  resolveNodeProcessSystemIdentity,
  validateNodeProcessHost,
  type NodeProcessHostContext,
} from "./node/process/context.ts";
import { unsupportedNodeOperation } from "./node/process/NodeError.ts";
import { nodeProcessSignalError, normalizeNodeSignal } from "./node/process/signals.ts";
import { createCpuUsage } from "./node/process/cpu-usage.ts";
import { createProcessWarnings } from "./node/process/warnings.ts";
import { processUmask } from "./node/process/umask.ts";
import { exposeProcessExports } from "./node/process/exports.ts";
import { createProcessCredentialGetters } from "./node/process/credentials.ts";
import { nodeExecveUnavailable } from "./node/process/execve.ts";
import { exposeNodeProcessStreams, type NodeProcessStdin } from "./node/process/streams.ts";
import { markNodeBuiltinCapability } from "./NodeBuiltinCapabilities.ts";
import { createNodeSystemMetrics } from "./NodeSystemMetrics.ts";

/* Adapted from Rivet agentOS's Node process bridge at 63ae3b256749d47c7b3a7c463128d5deda57d1bb.
 * This keeps its exit-event/typed-exit shape while requiring Signalbox host identity and capabilities.
 * Licensed under Apache-2.0; see ./bun/LICENSE.agentos and ./bun/NOTICE.agentos.
 */

export { NodeSystemError } from "./node/process/NodeError.ts";
export type {
  NodeProcessEnvironment,
  NodeProcessBuiltinModuleResolver,
  NodeProcessFileSystem,
  NodeProcessHostContext,
  NodeProcessStreams,
  NodeRuntimeIdentity,
  NodeRuntimeUserIdentity,
} from "./node/process/context.ts";
export type { NodeProcessStdin } from "./node/process/streams.ts";

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
  return markNodeBuiltinCapability(
    (..._args: unknown[]) => unsupportedNodeOperation(`process.${name}`),
    { status: "unsupported", evidence: `HostProcess.${name} has no host measurement capability` },
  );
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
  readonly stdin: NodeProcessStdin;
  readonly stdout: NodeProcessHostContext["streams"]["stdout"];
  readonly stderr: NodeProcessHostContext["streams"]["stderr"];
  readonly hrtime: HrtimeFunction;
  readonly emitWarning: ReturnType<typeof createProcessWarnings>;
  readonly #host: NodeProcessHostContext;
  readonly #systemIdentity: NonNullable<NodeProcessHostContext["systemIdentity"]>;
  readonly #metrics: ReturnType<typeof createNodeSystemMetrics>;
  readonly #monotonicNowNs: () => bigint;
  readonly #startTimeNs: bigint;
  memoryUsage: ReturnType<typeof createNodeSystemMetrics>["memoryUsage"];
  cpuUsage: ReturnType<typeof createCpuUsage>;
  resourceUsage: ReturnType<typeof createNodeSystemMetrics>["resourceUsage"];
  availableMemory: () => number;
  constrainedMemory: () => number;
  getuid: () => number;
  getgid: () => number;
  geteuid: () => number;
  getegid: () => number;
  getgroups: () => number[];

  #state: NodeProcessState = "running";
  #exitCode: number | undefined;

  constructor(host: NodeProcessHostContext) {
    super();
    this.#host = host;
    this.#systemIdentity = resolveNodeProcessSystemIdentity(host);
    this.hrtime = createHrtime(host.monotonicNowNs);
    this.#monotonicNowNs = this.hrtime.bigint;
    this.#startTimeNs = this.#monotonicNowNs();
    this.#metrics = createNodeSystemMetrics(this.#systemIdentity, {
      readMonotonicTimeNs: this.#monotonicNowNs,
      ...(host.cpuAccounting === undefined
        ? {}
        : { readCpuAccounting: () => host.cpuAccounting?.snapshot() }),
    });
    this.memoryUsage = this.#metrics.memoryUsage;
    this.cpuUsage = createCpuUsage(() => this.#metrics.cpuSnapshot());
    this.resourceUsage = this.#metrics.resourceUsage;
    this.availableMemory = () => this.#metrics.freeMemoryBytes;
    this.constrainedMemory = () => this.#metrics.totalMemoryBytes;
    const credentialGetters = createProcessCredentialGetters(host.filesystem);
    this.getuid = credentialGetters.getuid;
    this.getgid = credentialGetters.getgid;
    this.geteuid = credentialGetters.geteuid;
    this.getegid = credentialGetters.getegid;
    this.getgroups = credentialGetters.getgroups;
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
    const streams = exposeNodeProcessStreams(host.streams);
    this.stdin = streams.stdin;
    this.stdout = streams.stdout;
    this.stderr = streams.stderr;
    this.emitWarning = createProcessWarnings(this);

    for (const name of ["_events", "_eventsCount", "_maxListeners"]) {
      const descriptor = Object.getOwnPropertyDescriptor(this, name);
      if (descriptor?.enumerable) {
        Object.defineProperty(this, name, { ...descriptor, enumerable: false });
      }
    }
    // CJS-to-ESM conversion copies own exports, so prototype methods need bound properties.
    exposeProcessExports(this, host);
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

  getBuiltinModule(id: string): object | undefined {
    if (typeof id !== "string") {
      throw new TypeError('The "id" argument must be of type string');
    }
    return this.#host.resolveBuiltinModule?.(id);
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

  reallyExit(code?: number): never {
    return this.exit(code);
  }

  execve(file: string, args: readonly string[], env?: Readonly<Record<string, string>>): never {
    return nodeExecveUnavailable(file, args, env);
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

  // Kernel accounting stays exact when available; the shared profile supplies the fallback.
  getActiveResourcesInfo = unsupportedMeasurement("getActiveResourcesInfo");
  umask = (mask?: number | string) => processUmask(this.#host.filesystem, mask);
  uptime = () => Number(this.#monotonicNowNs() - this.#startTimeNs) / 1_000_000_000;
}

export function createNodeProcess(host: NodeProcessHostContext) {
  validateNodeProcessHost(host);
  return new HostProcess(host);
}

export default createNodeProcess;
