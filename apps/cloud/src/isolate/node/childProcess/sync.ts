import * as NodeBuffer from "node:buffer";

import type {
  KernelProgramHost,
  KernelProgramPrepareOptions,
} from "../../../kernel/KernelProgramHost.ts";
import type { ResolvedProgram } from "../../../kernel/KernelAbi.ts";
import { abortError, asChildProcessError, childProcessError, unwrapHostResult } from "./errors.ts";
import { ByteCollector, normalizeOutputOptions } from "./output.ts";
import { resolveGuestExecutable } from "./resolveExecutable.ts";
import {
  isArgumentList,
  normalizeShellCommand,
  normalizeSpawn,
  type NodeChildProcessDefaults,
  type NodeSyncOptions,
} from "./arguments.ts";

type SyncStdio = NonNullable<KernelProgramPrepareOptions["stdio"]>;

export interface NodeSpawnSyncResult {
  /** runInline executes without creating a KernelProcessTable identity. */
  readonly pid: undefined;
  readonly output: readonly [null, NodeBuffer.Buffer | string, NodeBuffer.Buffer | string];
  readonly stdout: NodeBuffer.Buffer | string;
  readonly stderr: NodeBuffer.Buffer | string;
  readonly status: number | null;
  readonly signal: string | null;
  readonly error?: Error;
}

export function createSyncMethods(
  host: KernelProgramHost,
  context: Parameters<KernelProgramHost["prepare"]>[0] & {
    readonly env: NodeChildProcessDefaults["env"];
  },
  defaults: NodeChildProcessDefaults,
) {
  function spawnSync(file: string, options?: NodeSyncOptions): NodeSpawnSyncResult;
  function spawnSync(
    file: string,
    args: readonly string[],
    options?: NodeSyncOptions,
  ): NodeSpawnSyncResult;
  function spawnSync(
    file: string,
    argsOrOptions?: readonly string[] | NodeSyncOptions,
    options?: NodeSyncOptions,
  ): NodeSpawnSyncResult {
    const [args, spawnOptions] = parseSpawnArguments(argsOrOptions, options);
    const normalized = normalizeSpawn(file, args, spawnOptions, defaults);
    return runInline(host, context, resolveExecutable(host, normalized, defaults), spawnOptions);
  }

  function execSync(command: string, options?: NodeSyncOptions): NodeBuffer.Buffer | string {
    if (typeof command !== "string") throw new TypeError('The "command" argument must be a string');
    const execOptions = options ?? {};
    if (typeof execOptions !== "object" || execOptions === null) {
      throw new TypeError('The "options" argument must be an object');
    }
    const shell = typeof execOptions.shell === "string" ? execOptions.shell : "/bin/sh";
    const normalized = normalizeShellCommand(
      command,
      {
        ...execOptions,
        shell,
      },
      defaults,
    );
    const result = runInline(
      host,
      context,
      resolveExecutable(host, normalized, defaults),
      execOptions,
      command,
    );
    return outputOrThrow(result, command);
  }

  function execFileSync(file: string, options?: NodeSyncOptions): NodeBuffer.Buffer | string;
  function execFileSync(
    file: string,
    args: readonly string[],
    options?: NodeSyncOptions,
  ): NodeBuffer.Buffer | string;
  function execFileSync(
    file: string,
    argsOrOptions?: readonly string[] | NodeSyncOptions,
    options?: NodeSyncOptions,
  ): NodeBuffer.Buffer | string {
    const [args, execOptions] = parseSpawnArguments(argsOrOptions, options);
    const normalized = normalizeSpawn(file, args, execOptions, defaults);
    const command = [file, ...args].join(" ");
    return outputOrThrow(
      runInline(host, context, resolveExecutable(host, normalized, defaults), execOptions, command),
      command,
    );
  }

  return Object.freeze({ spawnSync, execSync, execFileSync });
}

function parseSpawnArguments(
  argsOrOptions: readonly string[] | NodeSyncOptions | undefined,
  options: NodeSyncOptions | undefined,
): [readonly string[], NodeSyncOptions] {
  if (isArgumentList(argsOrOptions)) return [argsOrOptions, options ?? {}];
  if (argsOrOptions === undefined) return [[], options ?? {}];
  if (
    argsOrOptions !== undefined &&
    (typeof argsOrOptions !== "object" || argsOrOptions === null)
  ) {
    throw new TypeError('The "options" argument must be an object');
  }
  if (options !== undefined) throw new TypeError("Too many arguments");
  return [[], argsOrOptions ?? {}];
}

function runInline(
  host: KernelProgramHost,
  context: Parameters<KernelProgramHost["prepare"]>[0] & {
    readonly env: NodeChildProcessDefaults["env"];
  },
  spawn: ReturnType<typeof normalizeSpawn>,
  options: NodeSyncOptions,
  command?: string,
): NodeSpawnSyncResult {
  const outputOptions = normalizeOutputOptions(options, null);
  const stdout = new ByteCollector(outputOptions.maxBuffer);
  const stderr = new ByteCollector(outputOptions.maxBuffer);
  const input = normalizeInput(options.input, options.inputEncoding);
  const stdio = createSyncStdio(input, stdout, stderr);
  const emptyResult = (error?: Error, status: number | null = null): NodeSpawnSyncResult => {
    const out = stdout.output(outputOptions.encoding);
    const err = stderr.output(outputOptions.encoding);
    return {
      pid: undefined,
      output: [null, out, err],
      stdout: out,
      stderr: err,
      status,
      signal: null,
      ...(error ? { error: addCommand(error, command, out, err, status) } : {}),
    };
  };

  if (options.signal?.aborted) return emptyResult(abortError());
  if (options.signal !== undefined || spawn.timeout > 0) {
    return emptyResult(
      childProcessError(
        "Synchronous child execution cannot be interrupted while inline code is running",
        "ENOTSUP",
        { syscall: "spawnSync" },
      ),
    );
  }

  let prepared: ReturnType<KernelProgramHost["prepare"]> | undefined;
  let status: number | undefined;
  let error: Error | undefined;
  try {
    const program = unwrapHostResult(host.resolve(spawn.executable), "spawn") as ResolvedProgram;
    prepared = host.prepare(context, { cwd: spawn.cwd, stdio });
    status = host.runInline(prepared, program, spawn.argv, spawn.env);
  } catch (value) {
    error = asChildProcessError(value);
  } finally {
    try {
      prepared?.releaseSync();
    } catch (value) {
      error ??= asChildProcessError(value);
    }
  }

  if (stdout.exceeded || stderr.exceeded) {
    error ??= childProcessError(
      "stdout or stderr maxBuffer length exceeded",
      "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      { syscall: "spawnSync" },
    );
  }
  return emptyResult(error, status ?? null);
}

function resolveExecutable(
  host: KernelProgramHost,
  spawn: ReturnType<typeof normalizeSpawn>,
  defaults: NodeChildProcessDefaults,
) {
  const resolution = resolveGuestExecutable(host, spawn.spawnfile, {
    cwd: spawn.cwd,
    baseCwd: defaults.cwd(),
    PATH: spawn.env.PATH,
  });
  return { ...spawn, executable: resolution.executable };
}

function createSyncStdio(
  input: NodeBuffer.Buffer,
  stdout: ByteCollector,
  stderr: ByteCollector,
): SyncStdio {
  let inputOffset = 0;
  return [
    {
      readInto(target) {
        const bytesRead = Math.min(target.byteLength, input.byteLength - inputOffset);
        target.set(input.subarray(inputOffset, inputOffset + bytesRead));
        inputOffset += bytesRead;
        return bytesRead;
      },
    },
    {
      write(source) {
        stdout.append(source);
        return source.byteLength;
      },
    },
    {
      write(source) {
        stderr.append(source);
        return source.byteLength;
      },
    },
  ];
}

function normalizeInput(
  input: NodeSyncOptions["input"],
  encoding: NodeSyncOptions["inputEncoding"],
): NodeBuffer.Buffer {
  if (input === undefined) return NodeBuffer.Buffer.alloc(0);
  if (typeof input !== "string") return NodeBuffer.Buffer.from(input);
  if (encoding === "buffer")
    throw new TypeError('The "inputEncoding" option must be a string encoding');
  const selected = encoding ?? "utf8";
  if (!NodeBuffer.Buffer.isEncoding(selected))
    throw new TypeError(`Unknown input encoding: ${selected}`);
  return NodeBuffer.Buffer.from(input, selected);
}

function outputOrThrow(result: NodeSpawnSyncResult, command: string): NodeBuffer.Buffer | string {
  if (result.error) {
    throw addCommand(result.error, command, result.stdout, result.stderr, result.status);
  }
  if (result.status !== 0 || result.signal !== null) {
    throw childProcessError(`Command failed: ${command}`, result.status ?? 1, {
      cmd: command,
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
      signal: result.signal,
    });
  }
  return result.stdout;
}

function addCommand(
  error: Error,
  command: string | undefined,
  stdout: NodeBuffer.Buffer | string,
  stderr: NodeBuffer.Buffer | string,
  status: number | null,
): Error {
  const details = {
    ...(command === undefined ? {} : { cmd: command }),
    stdout,
    stderr,
    status,
    signal: null,
  };
  Object.assign(error, details);
  return error;
}
