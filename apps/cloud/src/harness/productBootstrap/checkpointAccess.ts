import * as Effect from "effect/Effect";
import type { HarnessHostSession, TurnAccess } from "../HarnessSessionHost.ts";

/** A restored native session has already installed this grant before its first request. */
export const createHarnessCProductCheckpointAccess = <G>(
  resolved: Omit<TurnAccess<G>, "signal">,
  preparationSignal: AbortSignal,
) =>
  Effect.gen(function* () {
    const controller = new AbortController();
    const listeners = new Map<AbortSignal, () => void>();
    const follow = (signal: AbortSignal) => {
      if (listeners.has(signal)) return;
      const abort = () => controller.abort(signal.reason);
      listeners.set(signal, abort);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    };
    follow(preparationSignal);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
        listeners.clear();
        controller.abort();
      }),
    );
    const access: TurnAccess<G> = { ...resolved, signal: controller.signal };
    let pending = true;
    return {
      access,
      firstRequestAccess: () => (pending ? access : undefined),
      bindSession: (session: HarnessHostSession<G>): HarnessHostSession<G> => ({
        ...session,
        turn: (input) =>
          Effect.suspend(() => {
            if (!pending) return session.turn(input);
            pending = false;
            follow(input.access.signal);
            return session.turn({ ...input, access });
          }),
      }),
    };
  });
