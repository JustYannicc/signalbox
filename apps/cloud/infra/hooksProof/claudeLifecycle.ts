// @effect-diagnostics globalTimers:off - the proof owns its deadline without an Effect runtime.
import type { KernelCpuProcessExecution } from "../../src/kernel/KernelCpuExecution.ts";
import type { KernelProcessTable } from "../../src/kernel/KernelProcessTable.ts";

export function createClaudeProofCleanup(
  processes: Pick<KernelProcessTable, "dispose">,
  cpuRoot: Pick<KernelCpuProcessExecution, "stop">,
) {
  let cancelling: Promise<void> | undefined;
  const cancelOwnedWork = () =>
    (cancelling ??= (async () => {
      const result = await processes.dispose();
      if (result.status !== "ok")
        throw new Error(`Claude hook process cleanup failed: ${JSON.stringify(result)}`);
    })());
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await cancelOwnedWork();
      } finally {
        cpuRoot.stop();
      }
    })());
  return { cancelOwnedWork, close };
}

interface ClaudeProofLifecycleOptions {
  readonly runtime: ReturnType<typeof createClaudeProofCleanup> & {
    readonly cpuRoot: Pick<KernelCpuProcessExecution, "run">;
    enterUser(): () => void;
  };
  readonly launch: () => Promise<unknown>;
  readonly terminal: Promise<void>;
  readonly guestError: (milestone: string, error: unknown) => void;
  readonly restore: () => void;
  readonly retain: (lifetime: Promise<void>) => void;
}

export async function runClaudeProofLifecycle(options: ClaudeProofLifecycleOptions) {
  let launchSettled = false;
  let cleanup: "pending" | "complete" | "failed" = "pending";
  let mockGlobalsRestored = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const snapshot = (deadlineExceeded: boolean) => ({
    deadlineExceeded,
    launchSettled,
    cleanup,
    mockGlobalsRestored,
  });
  const lifetime = (async () => {
    let leaveCpuUser: (() => void) | undefined;
    try {
      try {
        await options.runtime.cpuRoot.run(() => {
          leaveCpuUser = options.runtime.enterUser();
          return options.launch();
        });
      } catch (error) {
        options.guestError("release-error", error);
      } finally {
        launchSettled = true;
        const leave = leaveCpuUser;
        leaveCpuUser = undefined;
        try {
          leave?.();
        } catch (error) {
          options.guestError("cpu-scope-error", error);
        }
      }
      await options.terminal;
      try {
        await options.runtime.close();
        cleanup = "complete";
      } catch (error) {
        cleanup = "failed";
        options.guestError("cleanup-error", error);
      }
    } finally {
      try {
        options.restore();
        mockGlobalsRestored = true;
      } finally {
        if (deadline !== undefined) clearTimeout(deadline);
      }
    }
  })();
  const expired = new Promise<ReturnType<typeof snapshot>>((resolve) => {
    deadline = setTimeout(() => {
      options.guestError(
        "deadline",
        new Error("CLAUDE_BOOT_DEADLINE: launch, terminal observation or cleanup exceeded 20000ms"),
      );
      if (!launchSettled) {
        options.guestError(
          "launch-unsettled",
          new Error(
            "CLAUDE_LAUNCH_UNSETTLED: top-level JavaScript has no terminate API; its remaining lifetime is unknown",
          ),
        );
      }
      // Kernel cancellation cannot join top-level JS. Keep its mock globals and CPU scope owned.
      void options.runtime.cancelOwnedWork().catch((error) => {
        options.guestError("kernel-cleanup-error", error);
      });
      options.retain(lifetime);
      resolve(snapshot(true));
    }, 20_000);
  });
  // Only the fully joined lifetime can succeed. The watchdog returns a failed diagnostic.
  return await Promise.race([lifetime.then(() => snapshot(false)), expired]);
}
