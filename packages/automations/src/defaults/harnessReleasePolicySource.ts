import { deriveHarnessReleaseInheritedReachability } from "@t3tools/shared/harnessReleaseInheritedReachability";
import {
  canPromoteHarnessRelease,
  HARNESS_RELEASE_BACKFILL_LIMITS,
  HARNESS_RELEASE_RESULT_PATH,
  HARNESS_RELEASE_WORKFLOW_FILE,
  isVerifiedHarnessRelease,
  ledgerProviderFor,
  nextHarnessReleaseBatch,
  orderReleaseCandidates,
  releaseArtifactName,
  summarizeHarnessBackfill,
  releaseReceiptKey,
  releaseReceiptDisposition,
  releaseRunKey,
  shouldReuseReleaseReceipt,
} from "./harnessReleasePolicy.ts";
import { workflowFunctionSource } from "./workflowFunctionSource.ts";
import { isHarnessReleaseResourceCriteriaAssessment } from "@t3tools/shared/harnessReleaseResourceCriteria";
import { isHarnessReleaseBuiltinCriteriaAssessment } from "@t3tools/shared/harnessReleaseBuiltinCriteria";

const buildSource = () =>
  [
    `const HARNESS_RELEASE_WORKFLOW_FILE = ${JSON.stringify(HARNESS_RELEASE_WORKFLOW_FILE)};`,
    `const HARNESS_RELEASE_RESULT_PATH = ${JSON.stringify(HARNESS_RELEASE_RESULT_PATH)};`,
    `const HARNESS_RELEASE_BACKFILL_LIMITS = ${JSON.stringify(HARNESS_RELEASE_BACKFILL_LIMITS)};`,
    `const resourceCriteriaValidator = ${workflowFunctionSource(isHarnessReleaseResourceCriteriaAssessment)};`,
    `const inheritedReachability = ${workflowFunctionSource(deriveHarnessReleaseInheritedReachability)};`,
    `const builtinCriteriaValidator = ${workflowFunctionSource(isHarnessReleaseBuiltinCriteriaAssessment)};`,
    `const releaseArtifactName = ${workflowFunctionSource(releaseArtifactName)};`,
    `const isVerifiedHarnessRelease = ${workflowFunctionSource(isVerifiedHarnessRelease)};`,
    `const canPromoteHarnessRelease = ${workflowFunctionSource(canPromoteHarnessRelease)};`,
    `const ledgerProviderFor = ${workflowFunctionSource(ledgerProviderFor)};`,
    `const nextHarnessReleaseBatch = ${workflowFunctionSource(nextHarnessReleaseBatch)};`,
    `const orderReleaseCandidates = ${workflowFunctionSource(orderReleaseCandidates)};`,
    `const releaseReceiptKey = ${workflowFunctionSource(releaseReceiptKey)};`,
    `const releaseReceiptDisposition = ${workflowFunctionSource(releaseReceiptDisposition)};`,
    `const releaseRunKey = ${workflowFunctionSource(releaseRunKey)};`,
    `const shouldReuseReleaseReceipt = ${workflowFunctionSource(shouldReuseReleaseReceipt)};`,
    `const summarizeHarnessBackfill = ${workflowFunctionSource(summarizeHarnessBackfill)};`,
  ].join("\n");

let source: string | undefined;

export const getHarnessReleasePolicySource = () => {
  if (source === undefined) source = buildSource();
  return source;
};
