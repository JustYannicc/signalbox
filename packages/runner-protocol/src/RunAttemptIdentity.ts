import type { RunAttemptId } from "@t3tools/contracts";

/** A native conflict turn is a child of the cloud attempt, not a new cloud run. */
export const isRunAttemptOrContinuation = (
  currentAttemptId: RunAttemptId,
  observedAttemptId: RunAttemptId,
): boolean => {
  if (observedAttemptId === currentAttemptId) return true;
  const prefix = `${currentAttemptId}:`;
  if (!observedAttemptId.startsWith(prefix)) return false;
  return /^(?:sync|merge):[1-9]\d*$/.test(observedAttemptId.slice(prefix.length));
};
