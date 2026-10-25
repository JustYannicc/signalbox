import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { sha256 } from "./guards.ts";
import {
  assertClaudeDependencyPins,
  createClaudeDependencyPins,
  type ClaudeDependencyPin,
} from "./claudeDependencyPins.ts";
import { createClaudeRuntimeInputs } from "./claudeRuntimeInputs.ts";
import {
  assertClaudeRuntimeInputs,
  type ClaudeRuntimeBuildInputs,
  type ClaudeRuntimeInputProvenance,
} from "./claudeRuntimeInputProof.ts";

export type { ClaudeDependencyPin } from "./claudeDependencyPins.ts";
export type {
  ClaudeNodeWebModuleProvenance,
  PackageLicensePin,
  PackageSourcePin,
} from "./claudeRuntimeInputProof.ts";

export interface ClaudeBuildInputProvenance extends ClaudeRuntimeInputProvenance {
  readonly schemaVersion: 1;
  readonly lockfile: {
    readonly path: "pnpm-lock.yaml";
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly dependencies: ReadonlyArray<ClaudeDependencyPin>;
}

export interface ClaudeBuildInputs extends ClaudeRuntimeBuildInputs {
  readonly provenance: ClaudeBuildInputProvenance;
}

export async function createClaudeBuildInputs(repositoryPath: string): Promise<ClaudeBuildInputs> {
  const repository = await NodeFSP.realpath(repositoryPath);
  const lockBytes = await NodeFSP.readFile(NodePath.join(repository, "pnpm-lock.yaml"));
  const dependencies = await createClaudeDependencyPins(repository, lockBytes);
  const runtime = await createClaudeRuntimeInputs(repository);
  const sourceFreeze = await import("./sourceFreeze.ts").then((module) =>
    module.freezeSources(repository),
  );
  const provenance: ClaudeBuildInputProvenance = {
    schemaVersion: 1,
    lockfile: { path: "pnpm-lock.yaml", bytes: lockBytes.byteLength, sha256: sha256(lockBytes) },
    dependencies,
    ...runtime.provenance,
  };
  const inputs: ClaudeBuildInputs = { ...runtime, provenance };
  assertClaudeBuildInputs(inputs);
  const current = await import("./sourceFreeze.ts").then((module) =>
    module.freezeSources(repository),
  );
  if (sourceFreeze.sha256 !== current.sha256 || sourceFreeze.commit !== current.commit)
    throw new Error("CLAUDE_BUILD_INPUT_SOURCE_CHANGED");
  return inputs;
}

export function assertClaudeBuildInputs(inputs: ClaudeBuildInputs): void {
  assertClaudeRuntimeInputs(inputs);
  assertClaudeDependencyPins(inputs.provenance.dependencies);
}
