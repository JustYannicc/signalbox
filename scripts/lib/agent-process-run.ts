// @effect-diagnostics nodeBuiltinImport:off - the process supervisor must run without application dependencies.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { registerProcess, stop } from "../../packages/shared/src/agentProcesses/registry.ts";
import {
  ownedSessionId,
  processSessionId,
  sessions,
} from "../../packages/shared/src/agentProcessSessions.ts";
import { trackedEnvironment } from "./agent-process-environment.ts";

export async function runTrackedCommand(
  input: {
    command: string;
    args: string[];
    worktreePath: string;
    cwd: string;
    sessionId?: string | undefined;
  },
  register: typeof registerProcess = registerProcess,
) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- This dependency-free launcher also runs before HostProcess is installed.
  const trackingSupported = process.platform === "darwin" || process.platform === "linux";
  if (!trackingSupported) {
    process.stderr.write("Automatic process cleanup is unavailable on this platform.\n");
    const child = NodeChildProcess.spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: "inherit",
      shell: true,
    });
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  }
  const sessionId = processSessionId(
    await ownedSessionId(
      input.worktreePath,
      input.sessionId ?? process.env.SIGNALBOX_PROCESS_SESSION_ID,
      process.env.CODEX_THREAD_ID,
      process.env.CODEX_SESSION_ID,
    ),
  );
  let cleanupInProgress: ReturnType<typeof stop> | undefined;
  const cleanup = () => {
    cleanupInProgress ??= stop(input.worktreePath, { sessionId, ownerPid: process.pid }).finally(
      () => {
        cleanupInProgress = undefined;
      },
    );
    return cleanupInProgress;
  };
  const sessionDirectory = NodePath.join(input.worktreePath, ".t3", "agent-sessions");
  await NodeFSP.mkdir(sessionDirectory, { recursive: true });
  let sessionEnded = false;
  const checkSession = async () => {
    if (sessionEnded) return;
    if (
      (await sessions(input.worktreePath)).some(
        (session) => session.sessionId === sessionId && session.ended,
      )
    ) {
      sessionEnded = true;
      await cleanup();
    }
  };
  const reportFailure = (error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
  };
  const watcher = NodeFS.watch(sessionDirectory, { persistent: false }, () => {
    void checkSession().catch(reportFailure);
  });
  watcher.on("error", reportFailure);
  let stopRequested = false;
  const onSignal = () => {
    stopRequested = true;
    void cleanup().catch(reportFailure);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await checkSession();
    if (sessionEnded) throw new Error("The owning agent session has ended");
    if (stopRequested) return 143;
    const child = NodeChildProcess.spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: "inherit",
      env: trackedEnvironment({
        environment: process.env,
        worktreePath: input.worktreePath,
        sessionId,
        ownerPid: process.pid,
        preloadUrl: new URL("../agent-process-preload.ts", import.meta.url).href,
      }),
      detached: false,
    });
    const exited = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
    });
    void exited.catch(() => undefined);
    if (child.pid !== undefined) {
      await register({
        worktreePath: input.worktreePath,
        pid: child.pid,
        ownerPid: process.pid,
        sessionId,
        label: input.command,
      }).catch(async (error: unknown) => {
        if (child.exitCode === null && child.signalCode === null) {
          process.stderr.write(
            `Registration failed; stopping spawned command pid=${child.pid} cwd=${input.cwd}\n`,
          );
          child.kill("SIGKILL");
          await exited.catch(() => undefined);
          throw error;
        }
      });
    }
    await checkSession();
    if (stopRequested) await cleanup();
    return await exited;
  } finally {
    watcher.close();
    try {
      let result = await cleanup();
      for (
        let pass = 0;
        pass < 3 &&
        result.survivors.some((survivor) => survivor.reason === "registered during stop");
        pass++
      ) {
        result = await cleanup();
      }
      if (result.survivors.length > 0) {
        process.stderr.write(`Registered processes remain: ${JSON.stringify(result.survivors)}\n`);
      }
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }
}
