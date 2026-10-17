// signalbox: what the composer says while its project needs a pool.
import type { PoolNeed } from "@t3tools/client-runtime/state/sections";

/** The composer's copy for a pool need, given the pool's name once its views list it. */
export function needsPoolCopy(need: PoolNeed, poolName: string | undefined) {
  switch (need._tag) {
    case "noPool":
      return {
        action: "Choose a pool",
        why: "Nothing above this folder has a pool.",
        placeholder: "Choose a pool to send a message",
      };
    case "signIn": {
      const action = `Sign in to ${poolName ?? "its pool"}`;
      return {
        action,
        why: "Nobody is signed in to this folder's pool yet.",
        placeholder: `${action} to send a message`,
      };
    }
    case "noModels":
      return {
        action: "Open pool settings",
        why: need.message,
        placeholder: "No models are available from this pool right now.",
      };
    case "unavailable":
      return {
        action: "Open pool settings",
        why: need.message,
        placeholder: "This pool is unavailable right now.",
      };
  }
}

/**
 * Whether the send button blames the environment. Upstream folds "no provider"
 * into that, but a project that needs a pool has no provider by design and is
 * connected; its own reason (`NEEDS_A_POOL`) says why instead.
 */
export function sendBlamesEnvironment(input: {
  readonly environmentUnavailable: boolean;
  readonly projectSelectionRequired: boolean;
  readonly noProviderAvailable: boolean;
  readonly poolNeeded: boolean;
}) {
  return (
    input.environmentUnavailable ||
    input.projectSelectionRequired ||
    (input.noProviderAvailable && !input.poolNeeded)
  );
}
