import {
  HARNESS_PROOF_ENVIRONMENTS,
  HARNESS_PROVIDERS,
  HarnessReleaseLedgerError,
  REQUIRED_HARNESS_CHECKS,
  equalRecords,
  normalizeArtifact,
  normalizeExpectedRevision,
  normalizeNonEmptyString,
  normalizeProof,
  normalizeProvider,
  normalizeSelection,
  normalizeSelectionEvent,
  releaseEligibility,
} from "./internal/records.ts";
import type {
  HarnessProvider,
  HarnessReleaseArtifact,
  HarnessReleaseLedger,
  HarnessReleaseLedgerStore,
  HarnessReleaseLedgerTransaction,
  HarnessReleaseProof,
  HarnessReleaseSelection,
  HarnessSelectionAction,
} from "./internal/types.ts";

export {
  HARNESS_PROOF_ENVIRONMENTS,
  HARNESS_PROVIDERS,
  HarnessReleaseLedgerError,
  REQUIRED_HARNESS_CHECKS,
};
export type {
  HarnessCheckResult,
  HarnessEligibilityReason,
  HarnessMetric,
  HarnessProofCheck,
  HarnessProofEnvironment,
  HarnessProvider,
  HarnessReleaseArtifact,
  HarnessReleaseEligibility,
  HarnessReleaseLedger,
  HarnessReleaseLedgerStore,
  HarnessReleaseLedgerTransaction,
  HarnessReleaseProof,
  HarnessReleaseSelection,
  HarnessReleaseSelectionEvent,
  HarnessReleaseSelectionResult,
  HarnessSelectionAction,
} from "./internal/types.ts";

const assertArtifact = (
  transaction: HarnessReleaseLedgerTransaction,
  provider: HarnessProvider,
  releaseId: string,
) => {
  const artifact = transaction.getArtifact(provider, normalizeNonEmptyString(releaseId));
  if (artifact === null) throw new HarnessReleaseLedgerError("ARTIFACT_NOT_FOUND");
  return normalizeArtifact(artifact);
};

const identityMatches = (artifact: HarnessReleaseArtifact, proof: HarnessReleaseProof) =>
  artifact.provider === proof.provider &&
  artifact.releaseId === proof.releaseId &&
  artifact.artifactHash === proof.artifactHash &&
  artifact.sourceIdentity === proof.sourceIdentity &&
  artifact.fixtureIdentity === proof.fixtureIdentity;

const makeSelection = (
  provider: HarnessProvider,
  revision: number,
  currentReleaseId: string,
  lastGreenReleaseId: string,
  action: HarnessSelectionAction,
  changedAt: string,
): HarnessReleaseSelection => ({
  provider,
  revision,
  currentReleaseId,
  lastGreenReleaseId,
  action,
  changedAt,
});

export const createHarnessReleaseLedger = (
  store: HarnessReleaseLedgerStore,
): HarnessReleaseLedger => ({
  registerArtifact: (input) => {
    const artifact = normalizeArtifact(input);
    return store.transaction((transaction) => {
      const existing = transaction.getArtifact(artifact.provider, artifact.releaseId);
      if (existing !== null) {
        const stored = normalizeArtifact(existing);
        if (!equalRecords(stored, artifact))
          throw new HarnessReleaseLedgerError("IMMUTABLE_CONFLICT");
        return stored;
      }
      transaction.insertArtifact(artifact);
      return artifact;
    });
  },
  recordProof: (input) => {
    const proof = normalizeProof(input);
    return store.transaction((transaction) => {
      const artifact = assertArtifact(transaction, proof.provider, proof.releaseId);
      if (!identityMatches(artifact, proof))
        throw new HarnessReleaseLedgerError("IDENTITY_MISMATCH");
      const existing = transaction.getProof(proof.proofId);
      if (existing !== null) {
        const stored = normalizeProof(existing);
        if (!equalRecords(stored, proof)) throw new HarnessReleaseLedgerError("IMMUTABLE_CONFLICT");
        return stored;
      }
      transaction.appendProof(proof);
      return proof;
    });
  },
  getArtifact: (providerInput, releaseId) => {
    const provider = normalizeProvider(providerInput);
    const normalizedReleaseId = normalizeNonEmptyString(releaseId);
    return store.transaction((transaction) => {
      const artifact = transaction.getArtifact(provider, normalizedReleaseId);
      return artifact === null ? null : normalizeArtifact(artifact);
    });
  },
  listProofs: (providerInput, releaseId) => {
    const provider = normalizeProvider(providerInput);
    const normalizedReleaseId = normalizeNonEmptyString(releaseId);
    return store.transaction((transaction) =>
      transaction.listProofs(provider, normalizedReleaseId).map((proof) => normalizeProof(proof)),
    );
  },
  getEligibility: (providerInput, releaseId) => {
    const provider = normalizeProvider(providerInput);
    const normalizedReleaseId = normalizeNonEmptyString(releaseId);
    return store.transaction((transaction) => {
      assertArtifact(transaction, provider, normalizedReleaseId);
      return releaseEligibility(
        transaction.listProofs(provider, normalizedReleaseId).map((proof) => normalizeProof(proof)),
      );
    });
  },
  getSelection: (providerInput) => {
    const provider = normalizeProvider(providerInput);
    return store.transaction((transaction) =>
      normalizeSelection(transaction.getSelection(provider)),
    );
  },
  resolveCurrent: (providerInput) => {
    const provider = normalizeProvider(providerInput);
    return store.transaction((transaction) => {
      const selection = normalizeSelection(transaction.getSelection(provider));
      return selection.currentReleaseId === null
        ? null
        : assertArtifact(transaction, provider, selection.currentReleaseId);
    });
  },
  listSelectionEvents: (providerInput) => {
    const provider = normalizeProvider(providerInput);
    return store.transaction((transaction) =>
      transaction.listSelectionEvents(provider).map((event) => normalizeSelectionEvent(event)),
    );
  },
  compareAndSwapLastGreen: (input) => {
    const provider = normalizeProvider(input.provider);
    const releaseId = normalizeNonEmptyString(input.releaseId);
    const expectedRevision = normalizeExpectedRevision(input.expectedRevision);
    const changedAt = normalizeNonEmptyString(input.changedAt);
    return store.transaction((transaction) => {
      const current = normalizeSelection(transaction.getSelection(provider));
      if (current.revision !== expectedRevision) return { status: "conflict", selection: current };
      assertArtifact(transaction, provider, releaseId);
      const eligibility = releaseEligibility(
        transaction.listProofs(provider, releaseId).map((proof) => normalizeProof(proof)),
      );
      if (eligibility.status !== "green")
        return { status: "not-green", selection: current, eligibility };

      const next = makeSelection(
        provider,
        current.revision + 1,
        releaseId,
        releaseId,
        "green",
        changedAt,
      );
      if (!transaction.compareAndSwapSelection(provider, current.revision, next)) {
        return {
          status: "conflict",
          selection: normalizeSelection(transaction.getSelection(provider)),
        };
      }
      transaction.appendSelectionEvent({
        provider,
        revision: next.revision,
        action: "green",
        fromReleaseId: current.currentReleaseId,
        toReleaseId: releaseId,
        lastGreenReleaseId: releaseId,
        changedAt,
        reason: null,
      });
      return { status: "selected", selection: next };
    });
  },
  pinBack: (input) => {
    const provider = normalizeProvider(input.provider);
    const releaseId = normalizeNonEmptyString(input.releaseId);
    const expectedRevision = normalizeExpectedRevision(input.expectedRevision);
    const changedAt = normalizeNonEmptyString(input.changedAt);
    const reason = normalizeNonEmptyString(input.reason);
    return store.transaction((transaction) => {
      const current = normalizeSelection(transaction.getSelection(provider));
      if (current.revision !== expectedRevision) return { status: "conflict", selection: current };
      assertArtifact(transaction, provider, releaseId);
      if (!transaction.wasEverGreen(provider, releaseId)) {
        return { status: "never-green", selection: current };
      }
      const eligibility = releaseEligibility(
        transaction.listProofs(provider, releaseId).map((proof) => normalizeProof(proof)),
      );
      if (eligibility.status !== "green")
        return { status: "not-green", selection: current, eligibility };

      const lastGreenReleaseId = current.lastGreenReleaseId;
      if (lastGreenReleaseId === null) throw new HarnessReleaseLedgerError("CORRUPT_STORAGE");
      const next = makeSelection(
        provider,
        current.revision + 1,
        releaseId,
        lastGreenReleaseId,
        "pinback",
        changedAt,
      );
      if (!transaction.compareAndSwapSelection(provider, current.revision, next)) {
        return {
          status: "conflict",
          selection: normalizeSelection(transaction.getSelection(provider)),
        };
      }
      transaction.appendSelectionEvent({
        provider,
        revision: next.revision,
        action: "pinback",
        fromReleaseId: current.currentReleaseId,
        toReleaseId: releaseId,
        lastGreenReleaseId,
        changedAt,
        reason,
      });
      return { status: "selected", selection: next };
    });
  },
});
