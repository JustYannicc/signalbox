import * as NodePath from "node:path";
import type { HarnessReleaseArtifact } from "../../../src/harnessReleases/HarnessReleaseLedger.ts";
import type {
  HarnessCProductMachineService,
  HarnessCProductProgramService,
  HarnessCProductReleaseService,
} from "../../../src/harness/productBootstrap/contracts.ts";
import type { LoadHarnessReleaseOptions } from "../../../src/harness/HarnessReleaseLoader.ts";
import { productLoadedPreparedRelease } from "../../../src/harness/ProductHarnessProcessRelease.ts";
import { samePreparedRelease } from "../../../src/harness/processResume/identity.ts";
import { artifactDirectorySource } from "../prepareArtifact.ts";
import type { ClaudeQualificationComputerInputs } from "./computerInputs.ts";
import type { ClaudePairCandidate, ClaudeQualificationVariant } from "./contracts.ts";

export interface ClaudeQualificationPreparedVariant {
  readonly artifact: HarnessReleaseArtifact;
  readonly release: LoadHarnessReleaseOptions;
  readonly expectedPreparedRelease: ReturnType<typeof productLoadedPreparedRelease>;
  readonly preparedModuleBytes: number;
}

export function prepareVariant(
  artifact: HarnessReleaseArtifact,
  release: LoadHarnessReleaseOptions,
  loaded: NonNullable<Parameters<typeof productLoadedPreparedRelease>[2]>,
): ClaudeQualificationPreparedVariant {
  const expectedPreparedRelease = productLoadedPreparedRelease("claude-code", artifact, loaded);
  return {
    artifact,
    release,
    expectedPreparedRelease,
    preparedModuleBytes: Object.values(loaded.plan.preparedModules).reduce(
      (total, module) => total + module.bytes,
      0,
    ),
  };
}

export function assertActualLoadedCandidateRelease(
  actual: unknown,
  expected: ClaudeQualificationPreparedVariant["expectedPreparedRelease"],
) {
  if (
    !samePreparedRelease(
      actual as ClaudeQualificationPreparedVariant["expectedPreparedRelease"],
      expected,
    )
  )
    throw new Error("CLAUDE_QUALIFICATION_LOADED_RELEASE_MISMATCH");
  return actual as ClaudeQualificationPreparedVariant["expectedPreparedRelease"];
}

export function createCandidateServices(input: {
  readonly pairDirectory: string;
  readonly rows: Readonly<Record<ClaudeQualificationVariant, HarnessReleaseArtifact>>;
  readonly pair: ClaudePairCandidate;
  readonly computer: ClaudeQualificationComputerInputs;
  readonly identity: { readonly uid: number; readonly gid: number };
}) {
  const byRef = new Map(
    (["baseline", "hooks"] as const).map(
      (variant) =>
        [
          input.rows[variant].artifactRef,
          artifactDirectorySource(NodePath.join(input.pairDirectory, variant)),
        ] as const,
    ),
  );
  const programSeed = input.computer.makeProgramSeed(input.identity);
  const release: HarnessCProductReleaseService = {
    async getArtifact(provider, releaseId) {
      if (provider !== "claude-code") return null;
      return Object.values(input.rows).find((artifact) => artifact.releaseId === releaseId) ?? null;
    },
    async loaderConfig(provider) {
      if (provider !== "claude-code") throw new Error("CLAUDE_QUALIFICATION_PROVIDER_MISMATCH");
      return {
        trustedComputer: input.pair.trustedComputer,
        maxPreparedModuleBytes: input.pair.maxPreparedModuleBytes,
      };
    },
    async readArtifact(artifactRef, path) {
      const source = byRef.get(artifactRef);
      if (source === undefined) throw new Error("CLAUDE_QUALIFICATION_ARTIFACT_REF_UNKNOWN");
      return source.read(artifactRef, path);
    },
    async readArtifactChunk(artifactRef, path, offset, length) {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0
      )
        throw new Error("CLAUDE_QUALIFICATION_ARTIFACT_CHUNK_INVALID");
      const source = byRef.get(artifactRef);
      if (source === undefined) throw new Error("CLAUDE_QUALIFICATION_ARTIFACT_REF_UNKNOWN");
      return Uint8Array.from(
        (await source.read(artifactRef, path)).subarray(offset, offset + length),
      );
    },
  };
  const programs: HarnessCProductProgramService = {
    async catalog(provider) {
      if (provider !== "claude-code") throw new Error("CLAUDE_QUALIFICATION_PROVIDER_MISMATCH");
      return {
        sourceIdentity: programSeed.sourceIdentity,
        codes: input.computer.codes,
        files: programSeed.files,
      };
    },
    async read(path) {
      return programSeed.read(path, new AbortController().signal);
    },
  };
  const machine: HarnessCProductMachineService = {
    async inventory(provider) {
      if (provider !== "claude-code") throw new Error("CLAUDE_QUALIFICATION_PROVIDER_MISMATCH");
      return input.computer.machineInventory;
    },
  };
  return { release, programs, machine };
}
