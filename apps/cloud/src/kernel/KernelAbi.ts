// @effect-diagnostics cryptoRandomUUID:off - portable host capabilities cannot require an Effect runtime.
import { KernelWakeRegistry, type WakeSubscription, type WakeToken } from "./KernelWakeRegistry.ts";

export { KernelWakeRegistry, type WakeSubscription, type WakeToken } from "./KernelWakeRegistry.ts";

// Standard WASI belongs to node:wasi. This is the Signalbox host extension ABI.
export const ABI_VERSION = 1;
// Only implemented versions belong here. There is no v0 contract to negotiate.
export const SUPPORTED_ABI_VERSIONS: readonly number[] = Object.freeze([ABI_VERSION]);

export type KernelErrorCode =
  | "ABI_MISMATCH"
  | "INVALID_ARGUMENT"
  | "INVALID_HANDLE"
  | "UNSUPPORTED"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "PERMISSION_DENIED"
  | "RESOURCE_LIMIT"
  | "CANCELLED"
  | "EXPIRED"
  | "ALREADY_WAITING"
  | "IO_ERROR";
export type KernelResult<T> =
  | { readonly status: "ok"; readonly value: T }
  | {
      readonly status: "error";
      readonly error: { readonly code: KernelErrorCode; readonly message: string };
    }
  | { readonly status: "would_block"; readonly wakeToken: WakeToken };
export type KernelCall<T> = KernelResult<T> | Promise<KernelResult<T>>;
export const kernelOk = <T>(value: T) => ({ status: "ok", value }) as const;
export const kernelError = (code: KernelErrorCode, message: string) =>
  ({ status: "error", error: { code, message } }) as const;

export function negotiateAbiVersion(offered: readonly number[]): KernelResult<number> {
  const version = SUPPORTED_ABI_VERSIONS.find((candidate) => offered.includes(candidate));
  return version === undefined
    ? kernelError("ABI_MISMATCH", "No supported kernel ABI version was offered")
    : kernelOk(version);
}

export type KernelHandleKind = "process" | "resource" | "secret" | "pipe" | "pty" | "socket";
export interface KernelHandle<K extends KernelHandleKind = KernelHandleKind> {
  readonly id: string;
  readonly kind: K;
}

/** Opaque resource capabilities, not WASI descriptors. Removed identities are never reused. */
export class KernelResourceTable<
  Resources extends Record<KernelHandleKind, unknown> = Record<KernelHandleKind, unknown>,
> {
  readonly #entries = new Map<string, { kind: KernelHandleKind; value: unknown }>();
  readonly #maxHandles: number;

  constructor(maxHandles = 256) {
    if (!Number.isSafeInteger(maxHandles) || maxHandles < 1) {
      throw new RangeError("maxHandles must be a positive safe integer");
    }
    this.#maxHandles = maxHandles;
  }

  get size() {
    return this.#entries.size;
  }

  allocate<K extends KernelHandleKind>(
    kind: K,
    value: Resources[K],
  ): KernelResult<KernelHandle<K>> {
    if (this.size >= this.#maxHandles)
      return kernelError("RESOURCE_LIMIT", "Too many open handles");
    const handle = Object.freeze({ id: crypto.randomUUID(), kind });
    this.#entries.set(handle.id, { kind, value });
    return kernelOk(handle);
  }

  get<K extends KernelHandleKind>(handle: KernelHandle, kind: K): KernelResult<Resources[K]> {
    const entry = this.#entries.get(handle.id);
    if (!entry || handle.kind !== kind || entry.kind !== kind) {
      return kernelError("INVALID_HANDLE", "Unknown handle or wrong handle kind");
    }
    return kernelOk(entry.value as Resources[K]);
  }

  /** The owner performs backend cleanup after taking ownership of the resource. */
  take<K extends KernelHandleKind>(handle: KernelHandle, kind: K): KernelResult<Resources[K]> {
    const result = this.get(handle, kind);
    if (result.status === "ok") this.#entries.delete(handle.id);
    return result;
  }
}

type Operation<Input, Output> = { readonly input: Input; readonly output: Output };
export interface KernelOperations {
  "process.spawn": Operation<
    {
      program: ResolvedProgram;
      args: readonly string[];
      env: Readonly<Record<string, string | KernelHandle<"secret">>>;
    },
    KernelHandle<"process">
  >;
  "process.wait": Operation<{ handle: KernelHandle<"process"> }, { exitCode: number }>;
  "process.signal": Operation<
    { handle: KernelHandle<"process">; signal: "terminate" | "kill" },
    void
  >;
  escalate: Operation<{ reason: string; capability: string }, { requestId: string }>;
}
export type KernelCapability = keyof KernelOperations;
export type KernelBackend = {
  readonly [K in KernelCapability]?: (
    input: KernelOperations[K]["input"],
  ) => KernelCall<KernelOperations[K]["output"]>;
};

/** Synchronous host calls stay synchronous; process operations can return promises or WOULD_BLOCK. */
export function callKernel<K extends KernelCapability>(
  backend: KernelBackend,
  operation: K,
  input: KernelOperations[K]["input"],
): KernelCall<KernelOperations[K]["output"]> {
  const handler = backend[operation];
  if (typeof handler !== "function")
    return kernelError("UNSUPPORTED", `Kernel operation is unavailable: ${operation}`);
  if (operation === "process.spawn") {
    const { program } = input as KernelOperations["process.spawn"]["input"];
    if (!resolvedPrograms.has(program))
      return kernelError("INVALID_ARGUMENT", "Spawn requires a registry-resolved program");
    for (const capability of program.requiredCapabilities) {
      if (typeof backend[capability] !== "function")
        return kernelError("UNSUPPORTED", `Program requires unavailable operation: ${capability}`);
    }
  }
  try {
    const result = handler(input);
    return result instanceof Promise
      ? result.catch(() => kernelError("IO_ERROR", `Kernel operation failed: ${operation}`))
      : result;
  } catch {
    return kernelError("IO_ERROR", `Kernel operation failed: ${operation}`);
  }
}

/** Subscribe first, then try I/O. A completed notification remains consumable after return. */
export function attemptKernelOperation<T>(
  wakes: KernelWakeRegistry,
  subscribe: WakeSubscription,
  attempt: () => KernelResult<T> | { readonly status: "would_block" },
): KernelResult<T> {
  const registration = wakes.register(subscribe);
  if (registration.status !== "ok") return registration;
  const token = registration.value;
  try {
    const result = attempt();
    if (result.status === "would_block") return { status: "would_block", wakeToken: token };
    wakes.release(token);
    return result;
  } catch {
    wakes.release(token);
    return kernelError("IO_ERROR", "Kernel operation failed");
  }
}

export interface RegisteredProgram {
  readonly name: string;
  readonly version: string;
  readonly abiVersion: number;
  readonly requiredCapabilities: readonly KernelCapability[];
  /** Opaque loader key, never a command string or caller-selected executable path. */
  readonly entrypoint: string;
}

declare const resolvedProgram: unique symbol;
export type ResolvedProgram = RegisteredProgram & { readonly [resolvedProgram]: true };
const resolvedPrograms = new WeakSet<RegisteredProgram>();

export class KernelProgramRegistry {
  readonly #programs = new Map<string, Map<string, RegisteredProgram>>();
  readonly #maxPrograms: number;
  #size = 0;

  constructor(maxPrograms = 256) {
    if (!Number.isSafeInteger(maxPrograms) || maxPrograms < 1) {
      throw new RangeError("maxPrograms must be a positive safe integer");
    }
    this.#maxPrograms = maxPrograms;
  }

  register(program: RegisteredProgram): KernelResult<void> {
    if (!program.name.trim() || !program.version.trim() || !program.entrypoint.trim()) {
      return kernelError("INVALID_ARGUMENT", "Program name, version and entrypoint are required");
    }
    if (negotiateAbiVersion([program.abiVersion]).status !== "ok") {
      return kernelError("ABI_MISMATCH", "Program requires an unsupported kernel ABI");
    }
    const versions = this.#programs.get(program.name);
    if (versions?.has(program.version))
      return kernelError("ALREADY_EXISTS", "Program version is already registered");
    if (this.#size >= this.#maxPrograms)
      return kernelError("RESOURCE_LIMIT", "Too many registered programs");
    const registered = Object.freeze({
      ...program,
      requiredCapabilities: Object.freeze([...program.requiredCapabilities]),
    });
    const target = versions ?? new Map<string, RegisteredProgram>();
    target.set(program.version, registered);
    this.#programs.set(program.name, target);
    this.#size++;
    return kernelOk(undefined);
  }

  resolve(
    name: string,
    version: string,
    offeredAbiVersions: readonly number[],
    backend: KernelBackend,
  ): KernelResult<ResolvedProgram> {
    const program = this.#programs.get(name)?.get(version);
    if (!program) return kernelError("NOT_FOUND", "Program version is not registered");
    if (!offeredAbiVersions.includes(program.abiVersion))
      return kernelError("ABI_MISMATCH", "Caller does not support the program ABI");
    for (const capability of program.requiredCapabilities) {
      if (typeof backend[capability] !== "function")
        return kernelError("UNSUPPORTED", `Program requires unavailable operation: ${capability}`);
    }
    resolvedPrograms.add(program);
    return kernelOk(program as ResolvedProgram);
  }
}
