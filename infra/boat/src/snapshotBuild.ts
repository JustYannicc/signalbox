import type * as boat from "@distilled.cloud/boat-dev/boat";

/**
 * Whether reconcile keeps the observed snapshot, builds it, or refuses.
 * An empty or missing `recordedHash` means the snapshot was found without
 * state, so its inputs are unknown: it is kept as is, never rebuilt
 * implicitly.
 */
export const buildDecision = (input: {
  observed: boat.NamedSnapshot["status"] | undefined;
  recordedHash: string | undefined;
  sourceHash: string;
  rebuildRequested: boolean;
}): "keep" | "build" | "refuse" => {
  if (input.observed === undefined) return "build";
  if (input.rebuildRequested) return "build";
  if (!input.recordedHash) return input.observed === "ready" ? "keep" : "refuse";
  if (input.observed !== "ready") return "build";
  return input.recordedHash === input.sourceHash ? "keep" : "build";
};
