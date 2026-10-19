import * as NodeBuffer from "node:buffer";

import { asChildProcessError, childProcessError, type ChildProcessError } from "./errors.ts";
import type { NodeChildProcess } from "./ChildProcess.ts";
import {
  isArgumentList,
  normalizeSignal,
  type NodeChildProcessOptions,
  type NodeExecOptions,
} from "./arguments.ts";
import { ByteCollector, normalizeOutputOptions, type OutputOptions } from "./output.ts";

export type ExecCallback = (
  error: ChildProcessError | null,
  stdout: NodeBuffer.Buffer | string,
  stderr: NodeBuffer.Buffer | string,
) => void;

export type ChildProcessSpawner = (
  file: string,
  argsOrOptions?: readonly string[] | NodeChildProcessOptions,
  options?: NodeChildProcessOptions,
) => NodeChildProcess;

export type ShellCommandSpawner = (
  command: string,
  options: NodeChildProcessOptions,
) => NodeChildProcess;

export function createExecMethods(spawn: ChildProcessSpawner, spawnShell: ShellCommandSpawner) {
  function exec(command: string, callback?: ExecCallback): NodeChildProcess;
  function exec(
    command: string,
    options: NodeExecOptions,
    callback?: ExecCallback,
  ): NodeChildProcess;
  function exec(
    command: string,
    optionsOrCallback?: NodeExecOptions | ExecCallback,
    callback?: ExecCallback,
  ): NodeChildProcess {
    if (typeof optionsOrCallback === "function" && callback !== undefined) {
      throw new TypeError("Too many arguments");
    }
    const options = typeof optionsOrCallback === "function" ? {} : (optionsOrCallback ?? {});
    const done = validateCallback(
      typeof optionsOrCallback === "function" ? optionsOrCallback : callback,
    );
    if (typeof options !== "object" || options === null) {
      throw new TypeError('The "options" argument must be an object');
    }
    if (typeof command !== "string") throw new TypeError('The "command" argument must be a string');
    const outputOptions = normalizeOutputOptions(options);
    const shell = typeof options.shell === "string" ? options.shell : "/bin/sh";
    const child = spawnShell(command, { ...options, shell });
    collectResult(child, command, done, outputOptions, normalizeSignal(options.killSignal));
    return child;
  }

  function execFile(file: string, callback?: ExecCallback): NodeChildProcess;
  function execFile(
    file: string,
    args: readonly string[],
    callback?: ExecCallback,
  ): NodeChildProcess;
  function execFile(
    file: string,
    options: NodeExecOptions,
    callback?: ExecCallback,
  ): NodeChildProcess;
  function execFile(
    file: string,
    args: readonly string[],
    options: NodeExecOptions,
    callback?: ExecCallback,
  ): NodeChildProcess;
  function execFile(
    file: string,
    argsOrOptionsOrCallback?: readonly string[] | NodeExecOptions | ExecCallback,
    optionsOrCallback?: NodeExecOptions | ExecCallback,
    callback?: ExecCallback,
  ): NodeChildProcess {
    const { args, options, done } = parseExecFileArguments(
      argsOrOptionsOrCallback,
      optionsOrCallback,
      callback,
    );
    const outputOptions = normalizeOutputOptions(options);
    const child = spawn(file, args, options);
    collectResult(
      child,
      [file, ...args].join(" "),
      done,
      outputOptions,
      normalizeSignal(options.killSignal),
    );
    return child;
  }

  return Object.freeze({ exec, execFile });
}

function parseExecFileArguments(
  argsOrOptionsOrCallback: readonly string[] | NodeExecOptions | ExecCallback | undefined,
  optionsOrCallback: NodeExecOptions | ExecCallback | undefined,
  callback: ExecCallback | undefined,
): { args: readonly string[]; options: NodeExecOptions; done: ExecCallback | undefined } {
  const explicitCallback = validateCallback(callback);
  if (typeof argsOrOptionsOrCallback === "function") {
    if (optionsOrCallback !== undefined || explicitCallback !== undefined) {
      throw new TypeError("Too many arguments");
    }
    return { args: [], options: {}, done: argsOrOptionsOrCallback };
  }
  if (isArgumentList(argsOrOptionsOrCallback)) {
    if (typeof optionsOrCallback === "function") {
      if (explicitCallback !== undefined) throw new TypeError("Too many arguments");
      return {
        args: argsOrOptionsOrCallback,
        options: {},
        done: validateCallback(optionsOrCallback),
      };
    }
    if (
      optionsOrCallback !== undefined &&
      (typeof optionsOrCallback !== "object" || optionsOrCallback === null)
    ) {
      throw new TypeError('The "options" argument must be an object');
    }
    return {
      args: argsOrOptionsOrCallback,
      options: optionsOrCallback ?? {},
      done: explicitCallback,
    };
  }
  if (
    argsOrOptionsOrCallback === undefined &&
    optionsOrCallback !== undefined &&
    typeof optionsOrCallback !== "function"
  ) {
    if (typeof optionsOrCallback !== "object" || optionsOrCallback === null) {
      throw new TypeError('The "options" argument must be an object');
    }
    return { args: [], options: optionsOrCallback, done: callback };
  }
  if (typeof optionsOrCallback === "function") {
    if (explicitCallback !== undefined) throw new TypeError("Too many arguments");
    if (
      argsOrOptionsOrCallback !== undefined &&
      (typeof argsOrOptionsOrCallback !== "object" || argsOrOptionsOrCallback === null)
    ) {
      throw new TypeError('The "options" argument must be an object');
    }
    return {
      args: [],
      options: argsOrOptionsOrCallback ?? {},
      done: validateCallback(optionsOrCallback),
    };
  }
  if (optionsOrCallback !== undefined)
    throw new TypeError('The "callback" argument must be a function');
  if (
    argsOrOptionsOrCallback !== undefined &&
    (typeof argsOrOptionsOrCallback !== "object" || argsOrOptionsOrCallback === null)
  ) {
    throw new TypeError('The "options" argument must be an object');
  }
  return {
    args: [],
    options: argsOrOptionsOrCallback ?? {},
    done: explicitCallback,
  };
}

function validateCallback(value: unknown): ExecCallback | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "function")
    throw new TypeError('The "callback" argument must be a function');
  return value as ExecCallback;
}

function collectResult(
  child: NodeChildProcess,
  command: string,
  callback: ExecCallback | undefined,
  outputOptions: OutputOptions,
  killSignal: number,
): void {
  const stdout = new ByteCollector(outputOptions.maxBuffer);
  const stderr = new ByteCollector(outputOptions.maxBuffer);
  let processError: ChildProcessError | undefined;
  let settled = false;
  let maxBufferKillSent = false;

  const stopOnce = () => {
    if (maxBufferKillSent) return;
    maxBufferKillSent = true;
    stopAfterMaxBuffer(child, killSignal);
  };
  stdout.onLimit = stopOnce;
  stderr.onLimit = stopOnce;
  child.stdout?.on("data", (chunk: unknown) => stdout.append(chunk));
  child.stderr?.on("data", (chunk: unknown) => stderr.append(chunk));
  child.on("error", (error: unknown) => {
    processError = asChildProcessError(error);
  });
  child.on("close", () => {
    if (settled) return;
    settled = true;
    if (!callback) return;
    const out = stdout.output(outputOptions.encoding);
    const err = stderr.output(outputOptions.encoding);
    const error = resultError(child, processError, stdout, stderr, command, out, err);
    callback(error, out, err);
  });
}

function resultError(
  child: NodeChildProcess,
  processError: ChildProcessError | undefined,
  stdout: ByteCollector,
  stderr: ByteCollector,
  command: string,
  out: NodeBuffer.Buffer | string,
  err: NodeBuffer.Buffer | string,
): ChildProcessError | null {
  const details = {
    cmd: command,
    stdout: out,
    stderr: err,
    killed: child.killed,
    signal: child.signalCode,
  };
  if (stdout.exceeded || stderr.exceeded) {
    return childProcessError(
      "stdout or stderr maxBuffer length exceeded",
      "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      details,
    );
  }
  if (child.timedOut) {
    return childProcessError(`Command timed out: ${command}`, "ETIMEDOUT", details);
  }
  if (processError) {
    Object.assign(processError, details);
    return processError;
  }
  if (child.exitCode !== 0 || child.signalCode !== null) {
    const status = child.signalCode === null ? child.exitCode : null;
    const code = child.signalCode === null ? (status ?? 1) : null;
    return childProcessError(`Command failed: ${command}`, code, { ...details, status });
  }
  return null;
}

function stopAfterMaxBuffer(child: NodeChildProcess, killSignal: number): void {
  try {
    child.kill(killSignal);
  } catch {
    // The maxBuffer error is the useful result; close still drains the pipes.
  }
}
