import type { RunAttemptId, RunId, ThreadId } from "@t3tools/contracts";

import type { HarnessHookCallback, HarnessHookRequest, HarnessHookResult } from "./HarnessHooks.ts";

/** The run lease comes from the host's active Runner turn, never hook JSON. */
export interface ThreadHarnessActiveAttempt {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly generation: number;
}

/** Host closure over one thread and its live attempt source. */
export interface ThreadHarnessHookAuthority {
  readonly threadId: ThreadId;
  readonly activeAttempt: () => ThreadHarnessActiveAttempt | null;
}

export interface ThreadHarnessHookContext {
  readonly authority: {
    readonly threadId: ThreadId;
    /** SessionStart may have no active turn; run-scoped capabilities must reject null. */
    readonly activeAttempt: ThreadHarnessActiveAttempt | null;
  };
  /** Official request is preserved as received, including its sessionId and payload. */
  readonly request: HarnessHookRequest;
  readonly signal: AbortSignal;
}

/** Service wrappers must recheck the supplied attempt before committing an effect. */
export interface ThreadHarnessHookCapabilities {
  readonly invoke: (context: ThreadHarnessHookContext) => Promise<HarnessHookResult>;
}

/**
 * Binds hook dispatch to the host's thread and current Runner attempt. The
 * host must close over the real Thread RPC/service capabilities; request
 * session identifiers are retained only as official harness input.
 */
export function createThreadHarnessHookCallback(
  authority: ThreadHarnessHookAuthority,
  capabilities: ThreadHarnessHookCapabilities,
): HarnessHookCallback {
  return async (request, options) => {
    options.signal.throwIfAborted();

    const activeAttempt = authority.activeAttempt();
    options.signal.throwIfAborted();
    if (activeAttempt !== null && activeAttempt.threadId !== authority.threadId) {
      throw new Error("The active hook attempt belongs to another thread.");
    }

    const boundAuthority = Object.freeze({
      threadId: authority.threadId,
      activeAttempt: activeAttempt === null ? null : Object.freeze({ ...activeAttempt }),
    });
    const result = await capabilities.invoke({
      authority: boundAuthority,
      request,
      signal: options.signal,
    });
    options.signal.throwIfAborted();
    return result;
  };
}
