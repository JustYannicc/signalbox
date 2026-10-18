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
export type KernelCall<T> = KernelResult<T>;
export const kernelOk = <T>(value: T) => ({ status: "ok", value }) as const;
export const kernelError = (code: KernelErrorCode, message: string) =>
  ({ status: "error", error: { code, message } }) as const;

export function negotiateAbiVersion(offered: readonly number[]): KernelResult<number> {
  const version = SUPPORTED_ABI_VERSIONS.find((candidate) => offered.includes(candidate));
  return version === undefined
    ? kernelError("ABI_MISMATCH", "No supported kernel ABI version was offered")
    : kernelOk(version);
}

export type KernelHandleKind = "process" | "secret" | "pipe" | "pty" | "socket";
export interface KernelHandle<K extends KernelHandleKind = KernelHandleKind> {
  readonly id: string;
  readonly kind: K;
}
export type KernelResourceEntry<Resources extends Record<KernelHandleKind, unknown>> = {
  [K in KernelHandleKind]: { readonly kind: K; readonly value: Resources[K] };
}[KernelHandleKind];

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

  /** Transfer all resources to the request owner for backend cleanup on exit. */
  drain(): KernelResourceEntry<Resources>[] {
    const entries = [...this.#entries.values()] as KernelResourceEntry<Resources>[];
    this.#entries.clear();
    return entries;
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
export const KERNEL_CAPABILITIES = Object.freeze([
  "process.spawn",
  "process.wait",
  "process.signal",
  "escalate",
] as const satisfies readonly KernelCapability[]);
const knownCapabilities = new Set<string>(KERNEL_CAPABILITIES);
export type KernelBackend = {
  readonly [K in KernelCapability]?: (
    input: KernelOperations[K]["input"],
  ) => KernelResult<KernelOperations[K]["output"]>;
};

/** Async work returns WOULD_BLOCK; a JSPI owner can suspend on the wake registry outside the ABI. */
export function callKernel<K extends KernelCapability>(
  backend: KernelBackend,
  operation: K,
  input: KernelOperations[K]["input"],
): KernelResult<KernelOperations[K]["output"]> {
  try {
    let dispatchInput = input;
    if (operation === "process.spawn") {
      const spawn = input as KernelOperations["process.spawn"]["input"];
      const snapshot = Object.freeze({
        program: spawn.program,
        args: Object.freeze([...spawn.args]),
        env: Object.freeze(
          Object.fromEntries(
            Object.entries(spawn.env).map(([name, value]) => [
              name,
              typeof value === "string" ? value : Object.freeze({ id: value.id, kind: value.kind }),
            ]),
          ),
        ),
      });
      if (!resolvedPrograms.has(snapshot.program))
        return kernelError("INVALID_ARGUMENT", "Spawn requires a registry-resolved program");
      for (const capability of snapshot.program.requiredCapabilities) {
        if (!Object.hasOwn(backend, capability) || typeof backend[capability] !== "function")
          return kernelError(
            "UNSUPPORTED",
            `Program requires unavailable operation: ${capability}`,
          );
      }
      dispatchInput = snapshot as KernelOperations[K]["input"];
    }
    if (!knownCapabilities.has(operation) || !Object.hasOwn(backend, operation))
      return kernelError("UNSUPPORTED", `Kernel operation is unavailable: ${operation}`);
    const handler = backend[operation];
    if (typeof handler !== "function")
      return kernelError("UNSUPPORTED", `Kernel operation is unavailable: ${operation}`);
    return handler(dispatchInput);
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
    if (result.status === "would_block") {
      return wakes.has(token)
        ? { status: "would_block", wakeToken: token }
        : kernelError("CANCELLED", "Wake registration was released during the operation");
    }
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
    const registered = Object.freeze({
      name: program.name,
      version: program.version,
      abiVersion: program.abiVersion,
      entrypoint: program.entrypoint,
      requiredCapabilities: Object.freeze([...program.requiredCapabilities]),
    });
    if (!registered.name.trim() || !registered.version.trim() || !registered.entrypoint.trim()) {
      return kernelError("INVALID_ARGUMENT", "Program name, version and entrypoint are required");
    }
    if (negotiateAbiVersion([registered.abiVersion]).status !== "ok") {
      return kernelError("ABI_MISMATCH", "Program requires an unsupported kernel ABI");
    }
    if (registered.requiredCapabilities.some((capability) => !knownCapabilities.has(capability)))
      return kernelError("UNSUPPORTED", "Program requires an unknown kernel operation");
    const versions = this.#programs.get(registered.name);
    if (versions?.has(registered.version))
      return kernelError("ALREADY_EXISTS", "Program version is already registered");
    if (this.#size >= this.#maxPrograms)
      return kernelError("RESOURCE_LIMIT", "Too many registered programs");
    const target = versions ?? new Map<string, RegisteredProgram>();
    target.set(registered.version, registered);
    this.#programs.set(registered.name, target);
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
      if (!Object.hasOwn(backend, capability) || typeof backend[capability] !== "function")
        return kernelError("UNSUPPORTED", `Program requires unavailable operation: ${capability}`);
    }
    resolvedPrograms.add(program);
    return kernelOk(program as ResolvedProgram);
  }
}
