export const CONFIGURED_LIMIT_CRITERION =
  "configured-limit completion with measured overshoot" as const;
export const DEPLOYED_POLICY_CRITERION = "platform policy compliance evidence" as const;

export interface ConfiguredLimitCompletionInput {
  readonly configuredLimitBytes: number;
  readonly deltaMaxObservedBytes: number;
  readonly safetyMarginBytes: number;
  readonly budgetBytes: number;
  readonly calibrationComplete: boolean;
  readonly workloadCompleted: boolean;
  readonly identityVerified: boolean;
}

/** This empirical acceptance criterion never establishes a strict byte bound. */
export function assessConfiguredLimitCompletion(input: ConfiguredLimitCompletionInput) {
  const {
    configuredLimitBytes: limit,
    deltaMaxObservedBytes: delta,
    safetyMarginBytes: margin,
    budgetBytes: budget,
  } = input;
  const assessedBytes = limit + delta + margin;
  if (
    ![limit, delta, margin, budget].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    limit === 0 ||
    budget === 0 ||
    !Number.isSafeInteger(assessedBytes)
  )
    throw new TypeError("Invalid byte budget");
  const budgetFits = assessedBytes <= budget;
  const status: "pending" | "passed" | "rejected" = !budgetFits
    ? "rejected"
    : input.calibrationComplete !== true ||
        input.workloadCompleted !== true ||
        input.identityVerified !== true
      ? "pending"
      : "passed";
  return {
    criterion: "configured-limit completion with measured overshoot" as const,
    status,
    configuredLimitBytes: limit,
    deltaMaxObservedBytes: delta,
    safetyMarginBytes: margin,
    budgetBytes: budget,
    assessedBytes,
    budgetFits,
    calibrationComplete: input.calibrationComplete === true,
    workloadCompleted: input.workloadCompleted === true,
    identityVerified: input.identityVerified === true,
    strictByteBound: false as const,
    detail: !budgetFits
      ? "The observed calibration already exceeds the budget."
      : status === "pending"
        ? "Calibration, workload completion, or actual identity evidence is incomplete."
        : "The workload completed and the empirical budget criterion passed.",
  };
}

export interface V8TerminationEvidence {
  readonly exitCode?: number | null | undefined;
  readonly signal?: string | null | undefined;
  readonly waited: boolean;
  readonly timedOut: boolean;
  readonly identityVerified: boolean;
  readonly allocationRequestVerified: boolean;
  readonly stderr: string;
}

export function classifyV8Termination(
  evidence: V8TerminationEvidence,
): "V8_HEAP_OOM_PROCESS_TERMINATED" | "OTHER_TERMINATION" | "NO_VERIFIED_TERMINATION" {
  const actualExit = Number.isInteger(evidence.exitCode) && evidence.exitCode !== 0;
  const actualSignal = typeof evidence.signal === "string" && evidence.signal.trim().length > 0;
  const terminated = evidence.waited === true && (actualExit || actualSignal);
  if (
    terminated &&
    evidence.timedOut === false &&
    evidence.identityVerified === true &&
    evidence.allocationRequestVerified === true &&
    /JavaScript heap out of memory/u.test(evidence.stderr)
  )
    return "V8_HEAP_OOM_PROCESS_TERMINATED";
  return terminated ? "OTHER_TERMINATION" : "NO_VERIFIED_TERMINATION";
}

/** Start the clock before acquiring or invoking the cold public facet. */
export async function measureColdFirstSuccessfulRpc<A>(invokeCold: () => Promise<A>) {
  const started = process.hrtime.bigint();
  const value = await invokeCold();
  const finished = process.hrtime.bigint();
  return {
    value,
    timing: {
      label: "cold first-successful-RPC latency" as const,
      interpretation: "startup upper bound" as const,
      clock: "parent process.hrtime.bigint" as const,
      startedMonotonicNs: started.toString(),
      finishedMonotonicNs: finished.toString(),
      milliseconds: Number(finished - started) / 1e6,
      includesRpc: true as const,
      exactBootTime: false as const,
    },
  };
}
