// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - own and bound native CLI subprocesses without an Effect runtime.
import * as NodeChildProcess from "node:child_process";

// oxlint-disable t3code/no-global-process-runtime -- Standalone CLI process groups use the native host platform.

export interface ProbeProcess {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type RunProcess = (input: ProbeProcess) => Promise<{ code: number | null; stdout: string }>;

export const runProcess: RunProcess = (input) =>
  new Promise((resolve, reject) => {
    if (input.signal?.aborted) return reject(new Error("Probe subprocess interrupted."));
    const child = NodeChildProcess.spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
      // The Alchemy executable can spawn descendants. Only this captured process group is ours.
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let bytes = 0;
    let failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
          failure ??= new Error("Could not stop the owned probe subprocess.");
      }
    };
    const stop = (reason: string) => {
      if (failure) return;
      failure = new Error(reason);
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 5_000);
    };
    const abort = () => stop("Probe subprocess interrupted.");
    const timeout = setTimeout(() => stop("Probe subprocess timed out."), input.timeoutMs);
    input.signal?.addEventListener("abort", abort, { once: true });
    // Drain both streams, but never publish deployment output containing the endpoint or credentials.
    const consume = (chunk: string, capture: boolean) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 10 * 1024 * 1024) stop("Probe subprocess output exceeded 10 MiB.");
      else if (capture) stdout += chunk;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => consume(chunk, true));
    child.stderr.on("data", (chunk: string) => consume(chunk, false));
    child.on("error", () => {
      failure ??= new Error("Could not start the probe subprocess.");
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      clearTimeout(escalation);
      input.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve({ code, stdout });
    });
    if (input.signal?.aborted) abort();
  });
