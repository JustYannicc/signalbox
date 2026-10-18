import * as NodeOS from "node:os";

import { unsupportedNodeOperation } from "../process/NodeError.ts";
import type { NodeProcessHostContext } from "../process/context.ts";

export interface NodeChildProcessOptions {
  readonly argv0?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | number | undefined>>;
  readonly shell?: boolean | string;
  readonly stdio?: unknown;
  readonly signal?: AbortSignal;
  readonly timeout?: number;
  readonly killSignal?: string | number;
  readonly agentosPty?: boolean | { readonly cols?: number; readonly rows?: number };
}

export interface NodeExecOptions extends NodeChildProcessOptions {
  readonly encoding?: BufferEncoding | "buffer" | null;
  readonly maxBuffer?: number;
}

export interface NodeSyncOptions extends NodeExecOptions {
  readonly input?: string | Uint8Array;
  readonly inputEncoding?: BufferEncoding | "buffer" | null;
}

export interface NodeChildProcessDefaults {
  readonly env: NodeProcessHostContext["env"];
  readonly cwd: () => string;
}

export interface NormalizedSpawn {
  readonly spawnfile: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly timeout: number;
  readonly killSignal: number;
}

export function isArgumentList(value: unknown): value is readonly string[] {
  return Array.isArray(value);
}

export function normalizeSpawn(
  file: string,
  args: readonly string[],
  options: NodeChildProcessOptions,
  defaults: NodeChildProcessDefaults,
): NormalizedSpawn {
  if (typeof file !== "string") throw new TypeError('The "file" argument must be a string');
  if (file.length === 0) throw new TypeError('The "file" argument must not be empty');
  for (const argument of args) {
    if (typeof argument !== "string")
      throw new TypeError('The "args" argument must contain only strings');
  }
  if (options.agentosPty) unsupportedNodeOperation("child_process.pty");
  validateStdio(options.stdio);
  const shell = normalizeShell(options.shell);
  const argv0 = options.argv0 === undefined ? (shell ?? file) : String(options.argv0);
  const argv = shell ? [argv0, "-c", [file, ...args].join(" ")] : [argv0, ...args];
  const cwd = options.cwd === undefined ? defaults.cwd() : options.cwd;
  if (typeof cwd !== "string") throw new TypeError('The "cwd" option must be a string');
  return {
    spawnfile: shell ?? file,
    executable: shell ?? file,
    argv,
    env: normalizeEnvironment(options.env, defaults.env),
    cwd,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeout: normalizeTimeout(options.timeout),
    killSignal: normalizeSignal(options.killSignal),
  };
}

export function normalizeShellCommand(
  command: string,
  options: NodeChildProcessOptions,
  defaults: NodeChildProcessDefaults,
): NormalizedSpawn {
  if (typeof command !== "string") throw new TypeError('The "command" argument must be a string');
  const shell = normalizeCommandShell(options.shell);
  const normalized = normalizeSpawn(shell, ["-c", command], { ...options, shell: false }, defaults);
  const argv0 = options.argv0 === undefined ? shell : String(options.argv0);
  return {
    ...normalized,
    spawnfile: shell,
    executable: shell,
    argv: [argv0, "-c", command],
  };
}

export function normalizeEnvironment(
  override: NodeChildProcessOptions["env"],
  inherited: NodeProcessHostContext["env"],
): Readonly<Record<string, string>> {
  const source = override ?? inherited;
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) environment[key] = String(value);
  }
  return environment;
}

function validateStdio(stdio: unknown): void {
  if (stdio === undefined || stdio === "pipe") return;
  if (Array.isArray(stdio) && stdio.length === 3 && stdio.every((entry) => entry === "pipe"))
    return;
  unsupportedNodeOperation("child_process.stdio mode");
}

function normalizeShell(shell: boolean | string | undefined): string | undefined {
  if (shell === undefined || shell === false) return undefined;
  if (shell === true) return "/bin/sh";
  if (shell === "/bin/sh" || shell === "/bin/bash") return shell;
  unsupportedNodeOperation(`child_process.shell (${String(shell)})`);
}

function normalizeCommandShell(shell: boolean | string | undefined): string {
  if (shell === undefined || shell === true) return "/bin/sh";
  if (shell === "/bin/sh" || shell === "/bin/bash") return shell;
  unsupportedNodeOperation(`child_process.shell (${String(shell)})`);
}

function normalizeTimeout(timeout: number | undefined): number {
  if (timeout === undefined || timeout === 0) return 0;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0) {
    throw new RangeError('The "timeout" option must be a non-negative number');
  }
  return timeout;
}

const signalNumbers = NodeOS.constants.signals as Readonly<Record<string, number>>;
const signalNames = new Map(Object.entries(signalNumbers).map(([name, number]) => [number, name]));

export function normalizeSignal(signal: string | number | undefined): number {
  if (signal === undefined) return signalNumbers.SIGTERM ?? 15;
  if (typeof signal === "number" && Number.isInteger(signal) && signal >= 0) return signal;
  if (signal === "0") return 0;
  if (typeof signal !== "string")
    throw new TypeError('The "signal" argument must be a string or number');
  const number = signalNumbers[signal];
  if (number === undefined) throw new TypeError(`Unknown signal: ${signal}`);
  return number;
}

export function signalName(signal: string | number | null | undefined): string | null {
  if (signal == null) return null;
  if (typeof signal === "string") return signal;
  return signalNames.get(signal) ?? null;
}
