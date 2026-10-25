// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - own and bound native CLI subprocesses without an Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

// oxlint-disable t3code/no-global-process-runtime -- Standalone CLI process groups use the native host platform.

export interface ProbeProcess {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type RunProcess = (input: ProbeProcess) => Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}>;

export function diagnostics(stdout: string, stderr: string, env: NodeJS.ProcessEnv) {
  const redact = (value: string) => {
    let safe = NodeUtil.stripVTControlCharacters(value);
    for (const [key, secret] of Object.entries(env)) {
      if (secret && /SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY|ACCESS_KEY/i.test(key)) {
        safe = safe
          .replaceAll(secret, "[credential]")
          .replaceAll(encodeURIComponent(secret), "[credential]");
      }
    }
    return safe
      .replace(/\bhttps?:\/\/[^\s'"<>]+/giu, "[endpoint]")
      .replace(/\b[a-z0-9.-]+\.workers\.dev\b/giu, "[probe]")
      .replace(/\b(Bearer|Basic)\s+[a-z0-9+/_=.-]+/giu, "$1 [credential]");
  };
  return [redact(stdout).slice(-4096), redact(stderr).slice(-4096)].filter(Boolean).join("\n");
}

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
    let stderr = "";
    let bytes = 0;
    let failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let confirmation: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let exitCode: number | null = null;
    let shutdownComplete = true;
    const kill = (signal: NodeJS.Signals | 0) => {
      if (!child.pid) return false;
      try {
        return process.platform === "win32" ? child.kill(signal) : process.kill(-child.pid, signal);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
        if (signal !== 0)
          failure = new Error(
            `${failure?.message ?? "Probe subprocess failed."}\nCould not signal the owned probe process group.`,
          );
        return undefined;
      }
    };
    const finish = () => {
      if (!closed || !shutdownComplete) return;
      clearTimeout(escalation);
      clearTimeout(confirmation);
      if (failure)
        reject(new Error(diagnostics(failure.message, `${stdout}\n${stderr}`, input.env)));
      else resolve({ code: exitCode, stdout, stderr });
    };
    const confirmShutdown = (remaining = 40) => {
      const exists = kill(0);
      if (exists !== false && remaining > 0) {
        confirmation = setTimeout(() => confirmShutdown(remaining - 1), 25);
        return;
      }
      if (exists !== false)
        failure = new Error(
          `${failure?.message ?? "Probe subprocess failed."}\nCould not confirm owned probe process group exit after SIGKILL.`,
        );
      shutdownComplete = true;
      finish();
    };
    const stop = (reason: string) => {
      if (failure) return;
      failure = new Error(reason);
      shutdownComplete = false;
      kill("SIGTERM");
      escalation = setTimeout(() => {
        kill("SIGKILL");
        confirmShutdown();
      }, 5_000);
    };
    const abort = () => stop("Probe subprocess interrupted.");
    const timeout = setTimeout(() => stop("Probe subprocess timed out."), input.timeoutMs);
    input.signal?.addEventListener("abort", abort, { once: true });
    // Drain both streams, but never publish deployment output containing the endpoint or credentials.
    const consume = (chunk: string, capture: boolean) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 10 * 1024 * 1024) stop("Probe subprocess output exceeded 10 MiB.");
      else if (capture) stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => consume(chunk, true));
    child.stderr.on("data", (chunk: string) => consume(chunk, false));
    child.on("error", (error) => {
      failure ??= new Error(`Could not start the probe subprocess: ${error.message}`);
    });
    child.on("close", (code) => {
      closed = true;
      exitCode = code;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      // A closed group leader says nothing about descendants with independent stdio.
      if (!shutdownComplete && kill(0) === false) shutdownComplete = true;
      finish();
    });
    if (input.signal?.aborted) abort();
  });
