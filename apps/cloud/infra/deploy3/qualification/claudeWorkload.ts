import { snapshotPreparedRelease } from "../../../src/harness/processResume/identity.ts";
import {
  runClaudeQualificationPublicTurn,
  type PublicClaudeQualificationTurnFacet,
} from "../../harnessReleases/claudeQualification/publicTurn.ts";
import type { ClaudeQualificationPreparedVariant } from "../../harnessReleases/claudeQualification/candidateServices.ts";
import type {
  ClaudeQualificationVariant,
  ColdFirstSuccessfulRpcTimer,
  ColdFirstSuccessfulRpcTiming,
} from "../../harnessReleases/claudeQualification/contracts.ts";
import {
  collectClaudeQualificationWorkload,
  type ClaudeQualificationActionPin,
  type ClaudeQualificationClassification,
  type ClaudeQualificationEventPin,
  type ClaudeQualificationObserverTrace,
  type ClaudeQualificationWorkloadObservation,
  validateClaudeQualificationWorkloadPins,
} from "./claudeCollector.ts";

export interface ClaudeQualificationObserverRead {
  readonly runId: string;
  readonly requestId: string;
  /** The parent can drain these exact invocations before returning the retained Tail records. */
  readonly invocationIds: readonly string[];
}

export interface RunClaudeQualificationWorkloadInput {
  readonly classification: ClaudeQualificationClassification;
  readonly scenario: ClaudeQualificationVariant;
  readonly runId: string;
  readonly requestId: string;
  readonly acquireFacet: () => Promise<PublicClaudeQualificationTurnFacet>;
  readonly expectedPreparedRelease: ClaudeQualificationPreparedVariant["expectedPreparedRelease"];
  readonly publisher: Parameters<PublicClaudeQualificationTurnFacet["run"]>[0]["publisher"];
  readonly timer?: ColdFirstSuccessfulRpcTimer;
  readonly publicRunPin: ClaudeQualificationEventPin;
  readonly actionPins: readonly ClaudeQualificationActionPin[];
  readonly readObserverTrace: (
    input: ClaudeQualificationObserverRead,
  ) => Promise<ClaudeQualificationObserverTrace>;
}

/** Uses the public Claude facet's first run RPC; it never warms identity before that call. */
export async function runClaudeQualificationWorkload(
  input: RunClaudeQualificationWorkloadInput,
): Promise<ClaudeQualificationWorkloadObservation> {
  if (!input.runId || !input.requestId)
    throw new Error("CLAUDE_QUALIFICATION_WORKLOAD_IDENTITY_MISSING");
  validateClaudeQualificationWorkloadPins(input.requestId, input.publicRunPin, input.actionPins);
  const invocationIds = [
    ...new Set([
      input.requestId,
      input.publicRunPin.invocationId,
      ...input.actionPins.map((pin) => pin.invocationId),
    ]),
  ];
  let moduleInitNonceBefore: string | undefined;
  let moduleInitNonceAfter: string | undefined;

  const publicTurn = await runClaudeQualificationPublicTurn({
    acquireFacet: async () => {
      const facet = await input.acquireFacet();
      return {
        identity: () => facet.identity(),
        run: async (request) => {
          const result = await facet.run(request);
          moduleInitNonceBefore = requireModuleInitNonce(result, "before");
          return result;
        },
        loadedPreparedRelease: async () => {
          const actual = await facet.loadedPreparedRelease();
          moduleInitNonceAfter = requireModuleInitNonce(actual, "after");
          const snapshot = snapshotPreparedRelease(actual);
          if (!snapshot) throw new Error("CLAUDE_QUALIFICATION_LOADED_RELEASE_INVALID");
          return snapshot;
        },
        dispose: (expectedFacetNonce) => facet.dispose(expectedFacetNonce),
      };
    },
    timer: input.timer ?? claudeQualificationColdTimer,
    expected: input.expectedPreparedRelease,
    scenario: input.scenario,
    publisher: input.publisher,
    requestId: input.requestId,
  });

  if (!moduleInitNonceBefore || !moduleInitNonceAfter)
    throw new Error("CLAUDE_QUALIFICATION_MODULE_INIT_NONCE_MISSING");
  const observerTrace = await input.readObserverTrace({
    runId: input.runId,
    requestId: input.requestId,
    invocationIds,
  });
  return collectClaudeQualificationWorkload({
    classification: input.classification,
    scenario: input.scenario,
    runId: input.runId,
    requestId: input.requestId,
    coldStartupUpperBound: publicTurn.coldStartupUpperBound,
    turn: publicTurn.turn,
    expectedPreparedRelease: input.expectedPreparedRelease,
    loadedPreparedRelease: publicTurn.loadedPreparedRelease,
    moduleInitNonceBefore,
    moduleInitNonceAfter,
    publicRunPin: input.publicRunPin,
    actionPins: input.actionPins,
    observerTrace,
  });
}

export const claudeQualificationColdTimer: ColdFirstSuccessfulRpcTimer = {
  measureColdFirstSuccessfulRpc,
};

/** Matches EC1 API r2: the clock surrounds the first successful public RPC, with no warmup. */
export async function measureColdFirstSuccessfulRpc<A>(
  invokeCold: () => Promise<A>,
): Promise<{ readonly value: A; readonly timing: ColdFirstSuccessfulRpcTiming }> {
  const started = process.hrtime.bigint();
  const value = await invokeCold();
  const finished = process.hrtime.bigint();
  return {
    value,
    timing: {
      label: "cold first-successful-RPC latency",
      interpretation: "startup upper bound",
      clock: "parent process.hrtime.bigint",
      startedMonotonicNs: started.toString(),
      finishedMonotonicNs: finished.toString(),
      milliseconds: Number(finished - started) / 1e6,
      includesRpc: true,
      exactBootTime: false,
    },
  };
}

function requireModuleInitNonce(value: unknown, boundary: "before" | "after") {
  const raw = record(value);
  const nonce = raw?.isolateNonce;
  if (typeof nonce !== "string" || !nonce.trim())
    throw new Error(`CLAUDE_QUALIFICATION_MODULE_INIT_NONCE_${boundary.toUpperCase()}_MISSING`);
  return nonce;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
