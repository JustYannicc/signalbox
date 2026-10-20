import { WorkerEntrypoint } from "cloudflare:workers";
import { installCodeModeGlobals } from "./globals.ts";
import { captureCodeModeEffects, CodeModePump } from "./pump.ts";
import { restrictCodeModeGlobals } from "./scope.ts";
import "./upstreamSettled.js";
import type {
  CodeModeCellCompletion,
  CodeModeCellEvents,
  CodeModeCellInvocation,
} from "./types.ts";

export default class CodeModeCellWorker extends WorkerEntrypoint {
  async run(
    input: CodeModeCellInvocation,
    events: CodeModeCellEvents,
  ): Promise<CodeModeCellCompletion> {
    const effects = captureCodeModeEffects();
    const runtime = installCodeModeGlobals(input);
    const pump = new CodeModePump(runtime, events, effects);
    restrictCodeModeGlobals();
    let terminated = false;
    let error: string | null = null;
    let finished = false;
    const capture = (cause: unknown) => {
      if (error === null && !runtime.isExit(cause))
        error = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
    };
    const revoke = () => {
      runtime.revokeGuest();
      pump.clearTimers();
    };
    pump.start();
    const cancellation = events.cancelled().then(() => {
      if (!finished) {
        terminated = true;
        revoke();
        pump.cancel();
      }
    });
    void cancellation.catch((cause: unknown) => pump.fail(cause));
    // The trusted side-effect import avoids assimilating a guest-exported then function.
    const evaluation = import("./__code_mode_evaluation.js").finally(revoke);
    const evaluated = evaluation.then(
      () => undefined,
      () => undefined,
    );
    try {
      try {
        await Promise.race([evaluation, pump.failure, cancellation]);
      } catch (cause) {
        capture(cause);
      }
      revoke();
      try {
        // Natural completion must dispatch accepted output, notifications and unawaited tools.
        await pump.flush();
        if (!terminated) await Promise.race([pump.drainNotifications(), cancellation]);
      } catch (cause) {
        capture(cause);
      }
      try {
        await pump.drainOutput();
      } catch (cause) {
        capture(cause);
      }
    } finally {
      finished = true;
      revoke();
      try {
        await events.closeCallbacks();
      } finally {
        try {
          await pump.close();
        } finally {
          // A cancellation race or cleared timer cannot stand in for actual ESM settlement.
          await evaluated;
          await events.stopped();
        }
      }
    }
    return { terminated, error, writes: terminated ? {} : runtime.writes() };
  }
}
