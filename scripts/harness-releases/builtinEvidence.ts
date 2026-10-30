import {
  assessNodeBuiltinReachability,
  type BuiltinReachabilityCorpus,
  type NodeBuiltinReachabilityInventory,
} from "./nodeBuiltinGate/reachability.ts";

export interface PublicQualifierBuiltinEvidence {
  readonly inventory: NodeBuiltinReachabilityInventory;
  readonly corpus?: BuiltinReachabilityCorpus;
}

export interface TrustedPublicQualifierBuiltinEvidence extends PublicQualifierBuiltinEvidence {
  readonly expectedArtifactSha256: string;
}

/** Raw measurement flags cannot supply the public runtime inventory or accepted corpus. */
export function assessPublicQualifierBuiltinEvidence(
  evidence: TrustedPublicQualifierBuiltinEvidence,
  environment: "local-workerd" | "deployed",
  measurementRunId: string,
) {
  const assessment = assessNodeBuiltinReachability({
    artifactSha256: evidence.expectedArtifactSha256,
    inventory: evidence.inventory,
    ...(evidence.corpus === undefined ? {} : { corpus: evidence.corpus }),
  });
  if (
    environment === "deployed" &&
    assessment.coverageStatus === "passed" &&
    assessment.qualifiedRunId !== measurementRunId
  )
    throw new Error("RELEASE_BUILTIN_QUALIFICATION_RUN_MISMATCH");
  const status =
    environment === "local-workerd" && assessment.coverageStatus === "pending"
      ? "passed"
      : assessment.coverageStatus;
  return {
    assessment,
    check: {
      name: "builtinCoverage" as const,
      status,
      detail:
        environment === "local-workerd" && assessment.coverageStatus === "pending"
          ? "Static builtin preparation passed; observed release reachability is required on the deployed workload."
          : assessment.coverageStatus === "pending"
            ? "The accepted corpus does not include this deployed qualification workload."
            : assessment.coverageStatus === "rejected"
              ? assessment.blockers.join("; ")
              : "The accepted corpus has no reached unsupported calls; remaining named-error obligations stay open.",
    },
  };
}
