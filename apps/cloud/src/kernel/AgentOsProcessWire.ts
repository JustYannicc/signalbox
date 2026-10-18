/**
 * WASI `host_process.proc_spawn_v3` wire decoder from Rivet agentOS.
 * Source: https://github.com/rivet-dev/agentos/blob/63ae3b256749d47c7b3a7c463128d5deda57d1bb/toolchain/crates/wasi-ext/src/lib.rs
 */

import {
  decodeAgentOsSpawnActions,
  type AgentOsSpawnFileAction,
} from "./process/AgentOsProcessActions.ts";

export type { AgentOsSpawnFileAction } from "./process/AgentOsProcessActions.ts";

export const AGENTOS_PROCESS_ERRNO = Object.freeze({
  tooBig: 1,
  badFileDescriptor: 8,
  fault: 21,
  invalidArgument: 28,
  noEntry: 44,
  notSupported: 58,
} as const);

const SUPPORTED_SPAWN_FLAGS = 0xff;

// Match the pinned AgentOS runner and wasi-spawn client defaults. Caller limits
// can raise these only within explicit hard caps, so a guest cannot force an
// unbounded JS allocation with a forged u32 length.
export const AGENTOS_PROCESS_WIRE_DEFAULT_LIMITS = Object.freeze({
  maxArgCount: 4_096,
  maxEnvCount: 4_096,
  maxArgvBytes: 1024 * 1024,
  maxEnvBytes: 1024 * 1024,
  maxActionCount: 4_096,
  maxActionBytes: 1024 * 1024,
  maxPathBytes: 1024 * 1024,
  maxCwdBytes: 4_096,
} as const);

const HARD_LIMITS = Object.freeze({
  maxArgCount: 65_536,
  maxEnvCount: 65_536,
  maxArgvBytes: 16 * 1024 * 1024,
  maxEnvBytes: 16 * 1024 * 1024,
  maxActionCount: 65_536,
  maxActionBytes: 16 * 1024 * 1024,
  maxPathBytes: 16 * 1024 * 1024,
  maxCwdBytes: 16 * 1024,
} as const);

export interface AgentOsProcessWireLimits {
  readonly maxArgCount?: number;
  readonly maxEnvCount?: number;
  readonly maxArgvBytes?: number;
  readonly maxEnvBytes?: number;
  readonly maxActionCount?: number;
  readonly maxActionBytes?: number;
  readonly maxPathBytes?: number;
  readonly maxCwdBytes?: number;
}

type ResolvedLimits = Record<keyof typeof AGENTOS_PROCESS_WIRE_DEFAULT_LIMITS, number>;

export type AgentOsSpawnImportArguments = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export type AgentOsProcessWireResult<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "error"; readonly errno: number };

export interface AgentOsSpawnRequest {
  readonly execPath: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly actions: readonly AgentOsSpawnFileAction[];
  readonly cwd?: string;
  readonly attributes: {
    readonly flags: number;
    readonly defaultMask: { readonly low: number; readonly high: number };
    readonly signalMask: { readonly low: number; readonly high: number };
    readonly processGroup: number;
  };
  /** Validated guest-memory offset; recheck it when writing after async work. */
  readonly pidPointer: number;
}

const decoder = new TextDecoder();

function normalizeLimits(
  input: AgentOsProcessWireLimits | undefined,
): AgentOsProcessWireResult<ResolvedLimits> {
  const limits: ResolvedLimits = { ...AGENTOS_PROCESS_WIRE_DEFAULT_LIMITS };
  if (input === undefined) return { status: "ok", value: limits };

  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const value = input[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) {
      return { status: "error", errno: AGENTOS_PROCESS_ERRNO.invalidArgument };
    }
    if (value > HARD_LIMITS[key]) {
      return { status: "error", errno: AGENTOS_PROCESS_ERRNO.tooBig };
    }
    limits[key] = value;
  }
  return { status: "ok", value: limits };
}

function u32(value: number): number {
  return value >>> 0;
}

function i32(value: number): number {
  return value | 0;
}

function checkedRange(
  pointer: number,
  length: number,
  memoryBytes: number,
): AgentOsProcessWireResult<{ readonly start: number; readonly end: number }> {
  const start = u32(pointer);
  const size = u32(length);
  const end = start + size;
  if (end > memoryBytes) {
    return { status: "error", errno: AGENTOS_PROCESS_ERRNO.fault };
  }
  return { status: "ok", value: { start, end } };
}

function snapshotBytes(buffer: ArrayBufferLike, start: number, end: number): Uint8Array {
  return new Uint8Array(buffer, start, end - start).slice();
}

function decodeString(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function readStringList(
  bytes: Uint8Array,
  maximumCount: number,
): AgentOsProcessWireResult<readonly string[]> {
  if (bytes.length === 0) return { status: "ok", value: Object.freeze([]) };
  const result: string[] = [];
  let start = 0;
  for (let offset = 0; offset < bytes.length; offset++) {
    if (bytes[offset] !== 0) continue;
    result.push(decodeString(bytes.subarray(start, offset)));
    if (result.length > maximumCount) {
      return { status: "error", errno: AGENTOS_PROCESS_ERRNO.tooBig };
    }
    start = offset + 1;
  }
  // A final NUL terminates the last entry; an extra NUL preserves an empty
  // final entry as an empty string above.
  if (start < bytes.length) {
    result.push(decodeString(bytes.subarray(start)));
    if (result.length > maximumCount) {
      return { status: "error", errno: AGENTOS_PROCESS_ERRNO.tooBig };
    }
  }
  return { status: "ok", value: Object.freeze(result) };
}

function decodeEnvironment(
  bytes: Uint8Array,
  maximumCount: number,
): AgentOsProcessWireResult<Readonly<Record<string, string>>> {
  const entries = readStringList(bytes, maximumCount);
  if (entries.status !== "ok") return entries;
  const env = Object.create(null) as Record<string, string>;
  for (const entry of entries.value) {
    const delimiter = entry.indexOf("=");
    if (delimiter <= 0) continue;
    env[entry.slice(0, delimiter)] = entry.slice(delimiter + 1);
  }
  return { status: "ok", value: Object.freeze(env) };
}

/**
 * Snapshot the pinned `host_process.proc_spawn_v3` WASI inputs before any host
 * work can suspend. Source: Rivet agentOS `63ae3b256749d47c7b3a7c463128d5deda57d1bb`.
 */
export function decodeAgentOsSpawnRequest(
  memory: WebAssembly.Memory,
  args: readonly number[],
  requestedLimits?: AgentOsProcessWireLimits,
): AgentOsProcessWireResult<AgentOsSpawnRequest> {
  if (args.length !== 17) {
    return { status: "error", errno: AGENTOS_PROCESS_ERRNO.invalidArgument };
  }
  const [
    execPathPointer,
    execPathLength,
    argvPointer,
    argvLength,
    envPointer,
    envLength,
    actionsPointer,
    actionsLength,
    cwdPointer,
    cwdLength,
    spawnFlags,
    defaultMaskLow,
    defaultMaskHigh,
    signalMaskLow,
    signalMaskHigh,
    processGroup,
    pidPointer,
  ] = args as AgentOsSpawnImportArguments;
  const flags = u32(spawnFlags);
  if ((flags & ~SUPPORTED_SPAWN_FLAGS) !== 0) {
    return { status: "error", errno: AGENTOS_PROCESS_ERRNO.notSupported };
  }

  const normalizedLimits = normalizeLimits(requestedLimits);
  if (normalizedLimits.status !== "ok") return normalizedLimits;
  const limits = normalizedLimits.value;
  const execLength = u32(execPathLength);
  const argvBytesLength = u32(argvLength);
  const envBytesLength = u32(envLength);
  const actionBytesLength = u32(actionsLength);
  const cwdBytesLength = u32(cwdLength);

  if (
    execLength > limits.maxPathBytes ||
    argvBytesLength > limits.maxArgvBytes ||
    envBytesLength > limits.maxEnvBytes ||
    actionBytesLength > limits.maxActionBytes ||
    cwdBytesLength > limits.maxCwdBytes
  ) {
    return { status: "error", errno: AGENTOS_PROCESS_ERRNO.tooBig };
  }

  let buffer: ArrayBufferLike;
  try {
    buffer = memory.buffer;
  } catch {
    return { status: "error", errno: AGENTOS_PROCESS_ERRNO.fault };
  }
  const memoryBytes = buffer.byteLength;
  const ranges = [
    checkedRange(execPathPointer, execLength, memoryBytes),
    checkedRange(argvPointer, argvBytesLength, memoryBytes),
    checkedRange(envPointer, envBytesLength, memoryBytes),
    checkedRange(actionsPointer, actionBytesLength, memoryBytes),
    ...(cwdBytesLength === 0 ? [] : [checkedRange(cwdPointer, cwdBytesLength, memoryBytes)]),
    checkedRange(pidPointer, 4, memoryBytes),
  ];
  const failedRange = ranges.find((range) => range.status !== "ok");
  if (failedRange?.status === "error") return failedRange;
  const [execRange, argvRange, envRange, actionsRange, ...tail] = ranges;
  if (
    execRange?.status !== "ok" ||
    argvRange?.status !== "ok" ||
    envRange?.status !== "ok" ||
    actionsRange?.status !== "ok"
  ) {
    return { status: "error", errno: AGENTOS_PROCESS_ERRNO.fault };
  }
  const pidRange = tail.at(-1);
  const cwdRange = cwdBytesLength === 0 ? undefined : tail[0];
  if (pidRange?.status !== "ok" || (cwdRange !== undefined && cwdRange.status !== "ok")) {
    return { status: "error", errno: AGENTOS_PROCESS_ERRNO.fault };
  }

  const execPath = decodeString(snapshotBytes(buffer, execRange.value.start, execRange.value.end));
  if (execPath.length === 0) {
    return { status: "error", errno: AGENTOS_PROCESS_ERRNO.noEntry };
  }
  const argv = readStringList(
    snapshotBytes(buffer, argvRange.value.start, argvRange.value.end),
    limits.maxArgCount,
  );
  if (argv.status !== "ok") return argv;
  const env = decodeEnvironment(
    snapshotBytes(buffer, envRange.value.start, envRange.value.end),
    limits.maxEnvCount,
  );
  if (env.status !== "ok") return env;
  const actions = decodeAgentOsSpawnActions(
    snapshotBytes(buffer, actionsRange.value.start, actionsRange.value.end),
    { maxActionCount: limits.maxActionCount, maxPathBytes: limits.maxPathBytes },
    AGENTOS_PROCESS_ERRNO,
  );
  if (actions.status !== "ok") return actions;
  const cwd =
    cwdRange === undefined
      ? undefined
      : decodeString(snapshotBytes(buffer, cwdRange.value.start, cwdRange.value.end));

  const attributes = Object.freeze({
    flags,
    defaultMask: Object.freeze({ low: u32(defaultMaskLow), high: u32(defaultMaskHigh) }),
    signalMask: Object.freeze({ low: u32(signalMaskLow), high: u32(signalMaskHigh) }),
    processGroup: i32(processGroup),
  });
  return {
    status: "ok",
    value: Object.freeze({
      execPath,
      argv: argv.value,
      env: env.value,
      actions: actions.value,
      ...(cwd === undefined ? {} : { cwd }),
      attributes,
      pidPointer: pidRange.value.start,
    }),
  };
}

/** Write the successful child PID after async spawn completion. */
export function writeAgentOsPid(
  memory: WebAssembly.Memory,
  pidPointer: number,
  pid: number,
): number {
  if (!Number.isSafeInteger(pid) || pid < 0 || pid > 0xffff_ffff) {
    return AGENTOS_PROCESS_ERRNO.invalidArgument;
  }
  try {
    const buffer = memory.buffer;
    const range = checkedRange(pidPointer, 4, buffer.byteLength);
    if (range.status !== "ok") return range.errno;
    new DataView(buffer).setUint32(range.value.start, pid, true);
    return 0;
  } catch {
    return AGENTOS_PROCESS_ERRNO.fault;
  }
}
