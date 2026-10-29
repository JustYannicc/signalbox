import type { ClaudeNativeHostBindingOptions } from "./ClaudeNativeHostBinding.ts";
import type { HarnessHostOptions } from "./HarnessSessionHost.ts";
import type { LoadHarnessReleaseOptions } from "./HarnessReleaseLoader.ts";
import type {
  HarnessReleaseArtifact,
  HarnessReleaseLedger,
} from "../harnessReleases/HarnessReleaseLedger.ts";
import type { ConfiguredHarnessHook } from "../hooks/HarnessHookSettings.ts";
import {
  resolveClaudeReleaseVariants,
  sameClaudeReleaseArtifact,
} from "../harnessReleases/ClaudeReleaseVariants.ts";

export interface ProductClaudeReleaseVariants {
  /** The exact published catalog consumed by the producer's ledger resolver. */
  readonly catalog: unknown;
  readonly ledger: Pick<HarnessReleaseLedger, "getArtifact">;
}

export interface ProductClaudeHookSignals {
  /** SDK callback hooks that the native adapter installs before the first query. */
  readonly sdkCallbacks?: ClaudeNativeHostBindingOptions["toolObservation"];
  /** Registrations used to write the session's Claude settings hooks. */
  readonly settingsHooks?: readonly ConfiguredHarnessHook[] | undefined;
  /** Host callback for configured settings hooks. */
  readonly hookCallback?: HarnessHostOptions<unknown>["hooks"];
}

export function claudeProductHooksConfigured(input: ProductClaudeHookSignals): boolean {
  return (
    input.sdkCallbacks !== undefined ||
    (input.settingsHooks?.length ?? 0) > 0 ||
    input.hookCallback !== undefined
  );
}

export function selectProductClaudeHostRelease(input: {
  readonly release: LoadHarnessReleaseOptions;
  readonly releaseVariants: ProductClaudeReleaseVariants;
  readonly native: Pick<ClaudeNativeHostBindingOptions, "toolObservation">;
  readonly settingsHooks?: readonly ConfiguredHarnessHook[] | undefined;
  readonly hooks?: HarnessHostOptions<unknown>["hooks"];
  readonly processResumeArtifact?: HarnessReleaseArtifact;
}) {
  return selectProductClaudeRelease({
    release: input.release,
    releaseVariants: input.releaseVariants,
    hookSignals: {
      sdkCallbacks: input.native.toolObservation,
      settingsHooks: input.settingsHooks,
      hookCallback: input.hooks,
    },
    ...(input.processResumeArtifact === undefined
      ? {}
      : { processResumeArtifact: input.processResumeArtifact }),
  });
}

export function selectProductClaudeRelease(input: {
  readonly release: LoadHarnessReleaseOptions;
  readonly releaseVariants: ProductClaudeReleaseVariants;
  readonly hookSignals: ProductClaudeHookSignals;
  readonly processResumeArtifact?: HarnessReleaseArtifact;
}) {
  const hooksConfigured = claudeProductHooksConfigured(input.hookSignals);
  const catalog = resolveClaudeReleaseVariants(
    input.releaseVariants.catalog,
    input.releaseVariants.ledger,
  );
  const selected = hooksConfigured ? catalog.hooks.fullArtifact : catalog.baseline.fullArtifact;
  const currentIdentityMatchesCatalog = [
    catalog.baseline.fullArtifact,
    catalog.hooks.fullArtifact,
  ].some(
    (artifact) =>
      artifact.artifactRef === input.release.identity.artifactRef &&
      artifact.artifactHash === input.release.identity.artifactHash &&
      artifact.sourceIdentity === input.release.identity.sourceIdentity,
  );
  if (!currentIdentityMatchesCatalog)
    throw new Error("CLAUDE_PRODUCT_RELEASE_INPUT_NOT_IN_CATALOG");
  if (
    input.processResumeArtifact !== undefined &&
    !sameClaudeReleaseArtifact(input.processResumeArtifact, selected)
  )
    throw new Error("CLAUDE_PRODUCT_RELEASE_RESUME_VARIANT_MISMATCH");

  return {
    artifact: selected,
    release: {
      ...input.release,
      identity: {
        artifactRef: selected.artifactRef,
        artifactHash: selected.artifactHash,
        sourceIdentity: selected.sourceIdentity,
      },
    },
  };
}
