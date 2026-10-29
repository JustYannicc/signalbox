import {
  assertActualLoadedCandidateRelease,
  type ClaudeQualificationPreparedVariant,
} from "./candidateServices.ts";
import type {
  ClaudeQualificationColdStartupInput,
  ClaudeQualificationColdStartupObservation,
  PublicClaudeQualificationFacet,
} from "./contracts.ts";

const criterionNames = [
  "boot",
  "text",
  "readEdit",
  "bash",
  "grep",
  "resume",
  "mcp",
  "interrupt",
  "publicHarness",
] as const;

/** Synthetic guard for startup observation fields; it does not run Claude's public turn path. */
export async function observeClaudeColdStartup(
  input: Omit<ClaudeQualificationColdStartupInput, "expected"> & {
    readonly expected: ClaudeQualificationPreparedVariant["expectedPreparedRelease"];
  },
): Promise<ClaudeQualificationColdStartupObservation> {
  const measured = await input.timer.measureColdFirstSuccessfulRpc(async () => {
    const facet: PublicClaudeQualificationFacet = await input.acquireFacet();
    const identity = await facet.identity();
    if (!identity.facetNonce) throw new Error("CLAUDE_QUALIFICATION_FACET_IDENTITY_MISSING");
    const creation = await facet.startFresh({
      operationId: input.operationId,
      targetFacetNonce: identity.facetNonce,
      publisherKey: input.publisherKey,
    });
    assertCreation(creation, identity.facetNonce);
    return { facet, identity, creation };
  });
  const { facet, identity, creation } = measured.value;

  let loadedPreparedRelease: ReturnType<typeof assertActualLoadedCandidateRelease>;
  try {
    // This read intentionally follows startup: it opens the lazy facet runtime if needed.
    const observed = await facet.loadedPreparedRelease();
    loadedPreparedRelease = assertActualLoadedCandidateRelease(observed, input.expected);
  } finally {
    await facet.dispose(identity.facetNonce);
  }
  return {
    schema: "signalbox/claude-qualification-observation/v1",
    classification: "runtime-observation",
    status: "pending",
    scenario: input.scenario,
    coldStartupUpperBound: measured.timing,
    loadedPreparedRelease,
    creation,
    resourceEvidence: {
      schema: "signalbox/claude-configured-limit-resource-evidence/v1",
      criterion: "configured-limit completion with measured overshoot",
      status: "pending",
      strictByteBound: false,
      calibrationPins: input.calibrationPins,
      workloadCompletion: {
        status: "not-run",
        reason:
          "This bounded scenario starts and closes a public Claude facet without a workload turn.",
      },
      sessionClose: { status: "closed", acknowledged: true },
      deployedPolicyEvidence: {
        status: "pending",
        label: "platform policy compliance evidence",
      },
    },
    criteria: criterionNames.map((name) => ({
      name,
      status: "pending",
      detail:
        name === "boot"
          ? "The public cold-start observation is retained for the acceptance verifier."
          : "This scenario has no accepted evidence for this criterion.",
    })),
    metrics: {
      bootTimeMs: {
        state: "unmeasured",
        reason:
          "The cold first-successful-RPC latency is an upper-bound diagnostic, not the exact metric.",
      },
      peakHeapBytes: {
        state: "unmeasured",
        reason:
          "The current 96 MiB calibration profile is rejected and censored; no workload completion or sample is promoted to an accepted resource assessment.",
      },
    },
  };
}

function assertCreation(
  creation: Awaited<ReturnType<PublicClaudeQualificationFacet["startFresh"]>>,
  facetNonce: string,
) {
  if (
    creation.facetNonce !== facetNonce ||
    typeof creation.nativeSessionId !== "string" ||
    creation.nativeSessionId.length === 0 ||
    creation.joined.invocationRpc !== true ||
    creation.joined.fetch !== true ||
    creation.joined.ports !== true ||
    creation.checkpoint.native.id.length === 0 ||
    creation.checkpoint.filesystem.sha256.length === 0
  )
    throw new Error("CLAUDE_QUALIFICATION_PUBLIC_STARTUP_EVIDENCE_INCOMPLETE");
}
