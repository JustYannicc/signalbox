import {
  requireObservedInvocation,
  readObserverTrace,
  validPin,
  type ClaudeQualificationEventPin,
  type ClaudeQualificationObserverTrace,
} from "./claudeObserverTrace.ts";
export type {
  ClaudeQualificationRoute,
  ClaudeQualificationEventPin,
  ClaudeQualificationObserverTrace,
} from "./claudeObserverTrace.ts";

import type { HarnessProcessResumePreparedRelease } from "../../../src/harness/HarnessProcessResume.ts";
import {
  assertActualLoadedCandidateRelease,
  type ClaudeQualificationPreparedVariant,
} from "../../harnessReleases/claudeQualification/candidateServices.ts";
import {
  RELEASE_CRITERIA,
  type ReleaseCriterion,
} from "../../harnessReleases/claudeQualification/criteria.ts";
import type { ClaudeQualificationPublicTurnObservation } from "../../harnessReleases/claudeQualification/publicTurn.ts";
import type {
  ClaudeQualificationVariant,
  ColdFirstSuccessfulRpcTiming,
} from "../../harnessReleases/claudeQualification/contracts.ts";

export const CLAUDE_WORKLOAD_ACTIONS = [
  "text",
  "read",
  "edit",
  "bash",
  "grep",
  "resume",
  "mcp",
  "interrupt",
] as const;

export type ClaudeWorkloadAction = (typeof CLAUDE_WORKLOAD_ACTIONS)[number];
export type ClaudeQualificationClassification = "synthetic" | "official";

export interface ClaudeQualificationActionPin extends ClaudeQualificationEventPin {
  readonly action: ClaudeWorkloadAction;
}

export interface ClaudeQualificationCriterionEvidence {
  readonly name: ReleaseCriterion;
  readonly status: "pending";
  readonly events: readonly ClaudeQualificationEventPin[];
  readonly detail: string;
}

export interface ClaudeQualificationWorkloadObservation {
  readonly schema: "signalbox/claude-qualification-workload/v1";
  readonly classification: ClaudeQualificationClassification;
  readonly status: "observed";
  readonly qualification: "pending";
  readonly scenario: ClaudeQualificationVariant;
  readonly runId: string;
  readonly requestId: string;
  readonly firstPublicCall: "run";
  readonly identityWarmupBeforeFirstCall: false;
  readonly coldStartupUpperBound: ColdFirstSuccessfulRpcTiming;
  readonly loadedPreparedRelease: HarnessProcessResumePreparedRelease;
  readonly workloadCompletion: ClaudeQualificationPublicTurnObservation["turn"];
  readonly moduleInitNonce: {
    readonly before: string;
    readonly after: string;
    readonly same: true;
  };
  readonly criteria: readonly ClaudeQualificationCriterionEvidence[];
  readonly deployedPolicyEvidence: {
    readonly status: "pending";
    readonly label: "platform policy compliance evidence";
  };
}

export interface CollectClaudeQualificationWorkloadInput {
  readonly classification: ClaudeQualificationClassification;
  readonly scenario: ClaudeQualificationVariant;
  readonly runId: string;
  readonly requestId: string;
  readonly coldStartupUpperBound: ColdFirstSuccessfulRpcTiming;
  readonly turn: ClaudeQualificationPublicTurnObservation["turn"];
  readonly expectedPreparedRelease: ClaudeQualificationPreparedVariant["expectedPreparedRelease"];
  readonly loadedPreparedRelease: HarnessProcessResumePreparedRelease;
  readonly moduleInitNonceBefore: string;
  readonly moduleInitNonceAfter: string;
  readonly publicRunPin: ClaudeQualificationEventPin;
  readonly actionPins: readonly ClaudeQualificationActionPin[];
  readonly observerTrace: ClaudeQualificationObserverTrace;
}

export function validateClaudeQualificationWorkloadPins(
  requestId: string,
  publicRunPin: ClaudeQualificationEventPin,
  actionPins: readonly ClaudeQualificationActionPin[],
) {
  if (!requestId || publicRunPin.invocationId !== requestId || !validPin(publicRunPin))
    throw new Error("CLAUDE_QUALIFICATION_PUBLIC_RUN_PIN_MISMATCH");
  const actions = new Set<ClaudeWorkloadAction>();
  const invocations = new Set([`${publicRunPin.identity}\u0000${publicRunPin.invocationId}`]);
  for (const pin of actionPins) {
    const invocation = `${pin.identity}\u0000${pin.invocationId}`;
    if (
      !validPin(pin) ||
      !CLAUDE_WORKLOAD_ACTIONS.includes(pin.action) ||
      actions.has(pin.action) ||
      invocations.has(invocation)
    )
      throw new Error("CLAUDE_QUALIFICATION_WORKLOAD_ACTION_PINS_INVALID");
    actions.add(pin.action);
    invocations.add(invocation);
  }
  if (
    actions.size !== CLAUDE_WORKLOAD_ACTIONS.length ||
    CLAUDE_WORKLOAD_ACTIONS.some((name) => !actions.has(name))
  )
    throw new Error("CLAUDE_QUALIFICATION_WORKLOAD_ACTION_EVIDENCE_MISSING");
}

/** Keeps exact loader pins diagnostic until tool results and public C transitions are verified. */
export function collectClaudeQualificationWorkload(
  input: CollectClaudeQualificationWorkloadInput,
): ClaudeQualificationWorkloadObservation {
  if (
    !input.runId ||
    !input.requestId ||
    input.turn.requestId !== input.requestId ||
    input.turn.status !== "completed"
  )
    throw new Error("CLAUDE_QUALIFICATION_WORKLOAD_COMPLETION_MISSING");
  if (input.publicRunPin.invocationId !== input.requestId)
    throw new Error("CLAUDE_QUALIFICATION_PUBLIC_RUN_PIN_MISMATCH");
  validateClaudeQualificationWorkloadPins(input.requestId, input.publicRunPin, input.actionPins);
  validateTiming(input.coldStartupUpperBound);

  const loadedPreparedRelease = assertActualLoadedCandidateRelease(
    input.loadedPreparedRelease,
    input.expectedPreparedRelease,
  );
  const nonceBefore = nonEmpty(input.moduleInitNonceBefore);
  const nonceAfter = nonEmpty(input.moduleInitNonceAfter);
  if (!nonceBefore || !nonceAfter)
    throw new Error("CLAUDE_QUALIFICATION_MODULE_INIT_NONCE_MISSING");
  if (nonceBefore !== nonceAfter) throw new Error("CLAUDE_QUALIFICATION_MODULE_INIT_NONCE_CHANGED");

  const actual = readObserverTrace(input.observerTrace);
  const publicRun = requireObservedInvocation(actual, input.runId, input.publicRunPin);
  if (
    publicRun.entered.isolateNonce !== nonceBefore ||
    publicRun.terminal.isolateNonce !== nonceAfter
  )
    throw new Error("CLAUDE_QUALIFICATION_MODULE_INIT_NONCE_EVENT_MISMATCH");
  if (
    actual.events.some(
      (event) =>
        event.runId === input.runId &&
        event.identity === input.publicRunPin.identity &&
        event.entrypoint === input.publicRunPin.entrypoint &&
        event.producerClass === "dynamic-worker" &&
        event.isolateNonce !== nonceBefore,
    )
  )
    throw new Error("CLAUDE_QUALIFICATION_MODULE_INIT_NONCE_EVENT_MISMATCH");

  const actions = new Map<ClaudeWorkloadAction, ClaudeQualificationEventPin>();
  for (const pin of input.actionPins) {
    const observed = requireObservedInvocation(actual, input.runId, pin);
    if (
      observed.enteredIndex <= publicRun.enteredIndex ||
      observed.terminalIndex >= publicRun.terminalIndex
    )
      throw new Error("CLAUDE_QUALIFICATION_WORKLOAD_EVENT_OUTSIDE_PUBLIC_RUN");
    actions.set(pin.action, pin);
  }
  if (
    actions.size !== CLAUDE_WORKLOAD_ACTIONS.length ||
    CLAUDE_WORKLOAD_ACTIONS.some((name) => !actions.has(name))
  )
    throw new Error("CLAUDE_QUALIFICATION_WORKLOAD_ACTION_EVIDENCE_MISSING");

  const eventFor = (action: ClaudeWorkloadAction) => [actions.get(action)!];
  const byCriterion: Readonly<Record<ReleaseCriterion, readonly ClaudeQualificationEventPin[]>> = {
    boot: [],
    text: eventFor("text"),
    readEdit: [...eventFor("read"), ...eventFor("edit")],
    bash: eventFor("bash"),
    grep: eventFor("grep"),
    resume: eventFor("resume"),
    mcp: eventFor("mcp"),
    interrupt: eventFor("interrupt"),
    publicHarness: [input.publicRunPin],
  };

  return {
    schema: "signalbox/claude-qualification-workload/v1",
    classification: input.classification,
    status: "observed",
    qualification: "pending",
    scenario: input.scenario,
    runId: input.runId,
    requestId: input.requestId,
    firstPublicCall: "run",
    identityWarmupBeforeFirstCall: false,
    coldStartupUpperBound: input.coldStartupUpperBound,
    loadedPreparedRelease,
    workloadCompletion: input.turn,
    moduleInitNonce: { before: nonceBefore, after: nonceAfter, same: true },
    criteria: RELEASE_CRITERIA.map((name) => ({
      name,
      status: "pending" as const,
      events: byCriterion[name],
      detail:
        name === "publicHarness"
          ? "The producer pair does not prove the public C request and checkpoint transition."
          : "The producer pair does not prove the Claude tool call and its result.",
    })),
    deployedPolicyEvidence: {
      status: "pending",
      label: "platform policy compliance evidence",
    },
  };
}

function nonEmpty(value: string) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function validateTiming(timing: ColdFirstSuccessfulRpcTiming) {
  let started: bigint;
  let finished: bigint;
  try {
    started = BigInt(timing.startedMonotonicNs);
    finished = BigInt(timing.finishedMonotonicNs);
  } catch {
    throw new Error("CLAUDE_QUALIFICATION_COLD_RPC_TIMING_INVALID");
  }
  if (
    timing.label !== "cold first-successful-RPC latency" ||
    timing.interpretation !== "startup upper bound" ||
    timing.clock !== "parent process.hrtime.bigint" ||
    timing.includesRpc !== true ||
    timing.exactBootTime !== false ||
    finished < started ||
    timing.milliseconds !== Number(finished - started) / 1e6 ||
    !Number.isFinite(timing.milliseconds) ||
    timing.milliseconds < 0
  )
    throw new Error("CLAUDE_QUALIFICATION_COLD_RPC_TIMING_INVALID");
}
