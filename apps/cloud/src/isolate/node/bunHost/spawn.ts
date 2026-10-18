import { BunCapabilityUnavailable, type BunShimHost, type BunSpawnOptions } from "../../BunShim.ts";
import * as NodeOS from "node:os";
import type { createNodeChildProcess } from "../../NodeChildProcess.ts";
import type { createNodeProcess } from "../../NodeProcess.ts";
import { getSynchronousSpawnError } from "../childProcess/ChildProcess.ts";
import { childProcessError } from "../childProcess/errors.ts";
import { toBunChildOutputReadable, toBunWritable } from "./streams.ts";

type NodeChildProcessHost = Pick<ReturnType<typeof createNodeChildProcess>, "spawn">;
type BunProcess = Pick<
  ReturnType<typeof createNodeProcess>,
  "cwd" | "env" | "stdin" | "stdout" | "stderr"
>;
type BunWhich = NonNullable<BunShimHost["which"]>;
type BunSpawn = NonNullable<BunShimHost["spawn"]>;
type BunStdioMode = "pipe" | "ignore" | "inherit";

export function createBunSpawn(
  childProcess: NodeChildProcessHost,
  process: BunProcess,
  which: BunWhich,
): BunSpawn {
  return (command, options) => {
    const [requestedExecutable, ...args] = command;
    if (requestedExecutable === undefined) {
      throw new TypeError("Bun.spawn requires a nonempty command array of strings");
    }
    const stdio = normalizeSpawnStdio(options);
    validateSpawnOptions(options);

    const searchPath = options.env === undefined ? process.env.PATH : options.env.PATH;
    const executable = which(requestedExecutable, {
      ...(searchPath === undefined ? {} : { PATH: searchPath }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    if (executable === null) {
      throw childProcessError(`spawn ${requestedExecutable} ENOENT`, "ENOENT", {
        path: requestedExecutable,
        syscall: "spawn",
      });
    }

    const child = childProcess.spawn(executable, args, {
      argv0: options.argv0 ?? requestedExecutable,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      stdio: "pipe",
    });
    if (stdio.stdin === "ignore") child.stdin.end();
    else if (stdio.stdin === "inherit") {
      process.stdin.pipe(child.stdin);
      child.once("close", () => process.stdin.unpipe(child.stdin));
    }
    if (stdio.stdout === "ignore") child.stdout.resume();
    else if (stdio.stdout === "inherit") child.stdout.pipe(process.stdout, { end: false });
    if (stdio.stderr === "ignore") child.stderr.resume();
    else if (stdio.stderr === "inherit") child.stderr.pipe(process.stderr, { end: false });

    const exited = processExited(child);
    const pid = child.pid;
    if (pid === undefined) {
      void exited.catch(() => {});
      throw (
        getSynchronousSpawnError(child) ??
        childProcessError("Child process did not provide a PID before spawn returned", "EIO", {
          syscall: "spawn",
        })
      );
    }

    return {
      pid,
      exited,
      get exitCode() {
        return child.exitCode;
      },
      get signalCode() {
        return child.signalCode;
      },
      ...(stdio.stdin === "pipe" ? { stdin: toBunWritable(child.stdin) } : {}),
      ...(stdio.stdout === "pipe" ? { stdout: toBunChildOutputReadable(child.stdout) } : {}),
      ...(stdio.stderr === "pipe" ? { stderr: toBunChildOutputReadable(child.stderr) } : {}),
      kill(signal) {
        child.kill(signal);
      },
      ref() {
        // workerd has no Node event-loop liveness refcount to change.
      },
      unref() {
        // workerd has no Node event-loop liveness refcount to change.
      },
    };
  };
}

function normalizeSpawnStdio(options: BunSpawnOptions): {
  readonly stdin: BunStdioMode;
  readonly stdout: BunStdioMode;
  readonly stderr: BunStdioMode;
} {
  const entries = options.stdio;
  if (entries !== undefined && (!Array.isArray(entries) || entries.length !== 3)) {
    throw new BunCapabilityUnavailable("spawn.stdio");
  }
  return {
    stdin: stdioMode(options.stdin ?? entries?.[0], "ignore", "stdin"),
    stdout: stdioMode(options.stdout ?? entries?.[1], "pipe", "stdout"),
    stderr: stdioMode(options.stderr ?? entries?.[2], "inherit", "stderr"),
  };
}

function stdioMode(value: unknown, fallback: BunStdioMode, descriptor: string): BunStdioMode {
  if (value === undefined) return fallback;
  if (value === "pipe" || value === "ignore" || value === "inherit") return value;
  throw new BunCapabilityUnavailable(`spawn.${descriptor}`);
}

function validateSpawnOptions(options: BunSpawnOptions): void {
  if (options.detached === true) throw new BunCapabilityUnavailable("spawn.detached");
  if (options.terminal !== undefined && options.terminal !== false) {
    throw new BunCapabilityUnavailable("spawn.terminal");
  }
  if (options.windowsHide === true) throw new BunCapabilityUnavailable("spawn.windowsHide");
}

function processExited(child: ReturnType<NodeChildProcessHost["spawn"]>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    child.once("error", (error: Error) => reject(error));
    child.once("close", (code: number | null, signal: string | null) => {
      if (signal !== null) {
        const signalNumber =
          NodeOS.constants.signals[signal as keyof typeof NodeOS.constants.signals];
        if (typeof signalNumber !== "number") {
          reject(new Error(`Unknown child process signal: ${signal}`));
          return;
        }
        resolve(128 + signalNumber);
      } else if (code === null) {
        reject(new Error("The kernel child process exited without an exit code or signal"));
      } else {
        resolve(code);
      }
    });
  });
}
