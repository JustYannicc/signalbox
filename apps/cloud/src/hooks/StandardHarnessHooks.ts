import type { HarnessHookCallback } from "./HarnessHooks.ts";
import {
  createThreadHarnessHookCallback,
  type ThreadHarnessHookAuthority,
  type ThreadHarnessHookContext,
} from "./ThreadHarnessHooks.ts";

export interface StandardHarnessHookPorts {
  readonly thread: {
    /** Reuse a turn's status note, or ask the small model on its resolved pool to write one. */
    readonly ensureTurnStatus: (context: ThreadHarnessHookContext) => Promise<void>;
  };
  readonly gateway: {
    /** Fill registered secrets at point of use; the Gateway keeps model-wire scrubbing authoritative. */
    readonly beforeToolUse: (context: ThreadHarnessHookContext) => Promise<void>;
    /** Use the Gateway's model-wire scrubber and fail closed until secret values are registered. */
    readonly afterToolUse: (context: ThreadHarnessHookContext) => Promise<void>;
  };
  readonly automations: {
    /** Persist one turn-settled event per attempt; Automations owns done-condition evaluation. */
    readonly turnSettled: (context: ThreadHarnessHookContext) => Promise<void>;
  };
}

/**
 * Routes official hook events to their owning module. Ports must recheck the
 * supplied attempt atomically before effects and make them idempotent by attempt.
 */
export function createStandardHarnessHookCallback(
  authority: ThreadHarnessHookAuthority,
  ports: StandardHarnessHookPorts,
): HarnessHookCallback {
  return createThreadHarnessHookCallback(authority, {
    invoke: async (context) => {
      context.signal.throwIfAborted();
      if (context.request.event === "session-start") return {};

      requireActiveAttempt(context);
      switch (context.request.event) {
        case "pre-tool-use":
          await ports.gateway.beforeToolUse(context);
          break;
        case "post-tool-use":
          await ports.gateway.afterToolUse(context);
          break;
        case "stop":
          try {
            await ports.thread.ensureTurnStatus(context);
          } finally {
            // Holding settlement until a status note exists belongs to Thread's policy.
            context.signal.throwIfAborted();
            await ports.automations.turnSettled(context);
          }
          break;
      }

      context.signal.throwIfAborted();
      return {};
    },
  });
}

function requireActiveAttempt(context: ThreadHarnessHookContext): void {
  if (context.authority.activeAttempt === null) {
    throw new Error("Run-scoped hooks require an active thread attempt.");
  }
}
