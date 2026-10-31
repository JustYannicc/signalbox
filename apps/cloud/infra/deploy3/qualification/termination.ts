export interface V8TerminationEvidence {
  readonly exitCode?: unknown;
  readonly signal?: unknown;
  readonly waited: boolean;
  readonly timedOut?: boolean;
  readonly identityVerified: boolean;
  readonly allocationRequestVerified: boolean;
  readonly stderr: string;
}

export type V8TerminationClassification =
  | "V8_HEAP_OOM_PROCESS_TERMINATED"
  | "OTHER_TERMINATION"
  | "NO_VERIFIED_TERMINATION";

/** Ports EC1 API r2's process-termination classifier without making a heap qualification claim. */
export function classifyV8Termination(
  evidence: V8TerminationEvidence,
): V8TerminationClassification {
  const actualExit = Number.isInteger(evidence.exitCode) && evidence.exitCode !== 0;
  const actualSignal = typeof evidence.signal === "string" && evidence.signal.trim().length > 0;
  const terminated = evidence.waited === true && (actualExit || actualSignal);
  if (
    terminated &&
    evidence.timedOut === false &&
    evidence.identityVerified === true &&
    evidence.allocationRequestVerified === true &&
    /JavaScript heap out of memory/.test(evidence.stderr)
  )
    return "V8_HEAP_OOM_PROCESS_TERMINATED";
  return terminated ? "OTHER_TERMINATION" : "NO_VERIFIED_TERMINATION";
}
