import type { HarnessProcessResumePreparedRelease } from "../../../src/harness/HarnessProcessResume.ts";
import type {
  HarnessRequestPublisher,
  HarnessRunArtifact,
} from "../../../src/harness/HarnessRunStore.ts";
import {
  assertActualLoadedCandidateRelease,
  type ClaudeQualificationPreparedVariant,
} from "./candidateServices.ts";
import type { ColdFirstSuccessfulRpcTimer, ClaudeQualificationVariant } from "./contracts.ts";

export interface PublicClaudeQualificationTurnFacet {
  identity(): { readonly facetNonce: string } | Promise<{ readonly facetNonce: string }>;
  run(input: {
    readonly publisher: HarnessRequestPublisher;
    readonly requestId: string;
  }): Promise<unknown>;
  loadedPreparedRelease(): Promise<HarnessProcessResumePreparedRelease>;
  dispose(expectedFacetNonce: string): Promise<void>;
}

export interface ClaudeQualificationPublicTurnInput {
  /** Must return a stub for a fresh, uncontacted public Claude facet. */
  readonly acquireFacet: () => Promise<PublicClaudeQualificationTurnFacet>;
  readonly timer: ColdFirstSuccessfulRpcTimer;
  readonly expected: ClaudeQualificationPreparedVariant["expectedPreparedRelease"];
  readonly scenario: ClaudeQualificationVariant;
  readonly publisher: HarnessRequestPublisher;
  readonly requestId: string;
}

export interface ClaudeQualificationPublicTurnObservation {
  readonly schema: "signalbox/claude-qualification-public-turn/v1";
  readonly classification: "runtime-observation";
  readonly status: "pending";
  readonly scenario: ClaudeQualificationVariant;
  readonly firstPublicCall: "run";
  readonly identityWarmupBeforeFirstCall: false;
  readonly coldStartupUpperBound: Awaited<
    ReturnType<ColdFirstSuccessfulRpcTimer["measureColdFirstSuccessfulRpc"]>
  >["timing"];
  readonly loadedPreparedRelease: HarnessProcessResumePreparedRelease;
  readonly turn: {
    readonly requestId: string;
    readonly status: "completed";
    readonly input: HarnessRunArtifact;
    readonly result: HarnessRunArtifact;
    readonly checkpoint: {
      readonly native: HarnessRunArtifact;
      readonly filesystem: HarnessRunArtifact;
    };
  };
}

/** Measures the public run RPC that lazily opens the normal ProductClaude host and completes one turn. */
export async function runClaudeQualificationPublicTurn(
  input: ClaudeQualificationPublicTurnInput,
): Promise<ClaudeQualificationPublicTurnObservation> {
  let facet: PublicClaudeQualificationTurnFacet | undefined;
  let facetNonce: string | undefined;
  let observation: ClaudeQualificationPublicTurnObservation | undefined;
  let failure: unknown;
  try {
    const measured = await input.timer.measureColdFirstSuccessfulRpc(async () => {
      facet = await input.acquireFacet();
      const result = await facet.run({
        publisher: input.publisher,
        requestId: input.requestId,
      });
      return assertCompletedRequest(result, input.requestId);
    });

    if (facet === undefined) throw new Error("CLAUDE_QUALIFICATION_FACET_MISSING");
    const identity = await facet.identity();
    if (!identity.facetNonce) throw new Error("CLAUDE_QUALIFICATION_FACET_IDENTITY_MISSING");
    facetNonce = identity.facetNonce;
    const loadedPreparedRelease = assertActualLoadedCandidateRelease(
      await facet.loadedPreparedRelease(),
      input.expected,
    );
    observation = {
      schema: "signalbox/claude-qualification-public-turn/v1",
      classification: "runtime-observation",
      status: "pending",
      scenario: input.scenario,
      firstPublicCall: "run",
      identityWarmupBeforeFirstCall: false,
      coldStartupUpperBound: measured.timing,
      loadedPreparedRelease,
      turn: measured.value,
    };
  } catch (cause) {
    failure = cause;
  }

  if (facet !== undefined) {
    try {
      const nonce = facetNonce ?? (await facet.identity()).facetNonce;
      if (!nonce) throw new Error("CLAUDE_QUALIFICATION_FACET_IDENTITY_MISSING");
      await facet.dispose(nonce);
    } catch (cause) {
      failure =
        failure === undefined
          ? cause
          : new AggregateError([failure, cause], "Claude qualification turn and cleanup failed.");
    }
  }
  if (failure !== undefined) throw failure;
  if (observation === undefined) throw new Error("CLAUDE_QUALIFICATION_OBSERVATION_MISSING");
  return observation;
}

function assertCompletedRequest(
  value: unknown,
  requestId: string,
): ClaudeQualificationPublicTurnObservation["turn"] {
  const result = record(value);
  const snapshot = record(result?.snapshot);
  const requests = record(snapshot?.requests);
  const entries = requests?.entries;
  if (result?.action !== "committed" || !Array.isArray(entries))
    throw new Error("CLAUDE_QUALIFICATION_PUBLIC_TURN_NOT_COMMITTED");

  const matches = entries.filter(
    (entry) => record(record(entry)?.request)?.requestId === requestId,
  );
  if (matches.length !== 1) throw new Error("CLAUDE_QUALIFICATION_PUBLIC_TURN_REQUEST_MISSING");
  const entry = record(matches[0]);
  const request = record(entry?.request);
  const finish = record(entry?.finish);
  if (
    entry?.status !== "completed" ||
    finish?.status !== "completed" ||
    request === undefined ||
    finish === undefined
  )
    throw new Error("CLAUDE_QUALIFICATION_PUBLIC_TURN_NOT_COMPLETED");

  return {
    requestId,
    status: "completed",
    input: artifact(request.input),
    result: artifact(finish.result),
    checkpoint: checkpoint(finish.checkpoint),
  };
}

function checkpoint(value: unknown) {
  const raw = record(value);
  if (raw === undefined) throw new Error("CLAUDE_QUALIFICATION_PUBLIC_TURN_CHECKPOINT_INVALID");
  return {
    native: artifact(raw.native),
    filesystem: artifact(raw.filesystem),
  };
}

function artifact(value: unknown): HarnessRunArtifact {
  const raw = record(value);
  if (
    typeof raw?.id !== "string" ||
    raw.id.length === 0 ||
    !Number.isSafeInteger(raw.bytes) ||
    (raw.bytes as number) < 0 ||
    typeof raw.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(raw.sha256)
  )
    throw new Error("CLAUDE_QUALIFICATION_PUBLIC_TURN_ARTIFACT_INVALID");
  return { id: raw.id, bytes: raw.bytes as number, sha256: raw.sha256 };
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
