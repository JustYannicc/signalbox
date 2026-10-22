import type { HarnessRelease } from "../HarnessRelease.ts";
import type { HarnessReleaseOmissionIdentity } from "../../harnessReleases/HarnessReleaseArtifact.ts";

export interface ReleaseFile {
  readonly bytes: number;
  readonly sha256: string;
}

export interface ComputerIdentity {
  readonly sourceIdentity: string;
  readonly manifestSha256: string;
}

/** Common metadata has already passed the artifact reader's validation. */
export interface VerifiedReleaseArtifact {
  readonly manifest: {
    readonly schemaVersion: 1;
    readonly harness: "codex" | "claude-code";
    readonly sourceIdentity: string;
    readonly components: {
      readonly codex?: { readonly manifest: string };
      readonly cli?: { readonly manifest: string };
      readonly sdk?: { readonly manifest: string };
    };
    readonly files: Readonly<Record<string, ReleaseFile>>;
    readonly omission?: HarnessReleaseOmissionIdentity;
    readonly computer: ComputerIdentity;
  };
  readonly rawManifests: {
    readonly codex?: Readonly<Record<string, unknown>>;
    readonly cli?: Readonly<Record<string, unknown>>;
    readonly sdk?: Readonly<Record<string, unknown>>;
  };
}

export interface HarnessReleasePlanInput extends VerifiedReleaseArtifact {
  readonly artifactHash: string;
  readonly trustedComputer: ComputerIdentity;
  /** Trusted caller allowance for all prepared modules, including loader and SDK modules. */
  readonly maxPreparedModuleBytes: number;
}

export type ReleaseComponent = "codex" | "cli" | "sdk";
export type PreparedModuleType = "js" | "cjs" | "text" | "wasm";

export interface PreparedReleaseFile extends ReleaseFile {
  readonly component: ReleaseComponent;
  readonly name: string;
  /** Path passed to the accepted artifact reader, relative to the common artifact. */
  readonly path: string;
}

export interface PreparedReleaseModule extends PreparedReleaseFile {
  readonly type: PreparedModuleType;
}

export interface PreparedReleaseAsset extends PreparedReleaseFile {
  readonly key: string;
  readonly loader: number;
  readonly encoding: number;
}

interface PlanBase {
  readonly release: HarnessRelease;
  readonly sourceIdentity: string;
  readonly computer: ComputerIdentity;
  /** Keys include the component. Values retain the native module name for relative imports. */
  readonly preparedModules: Readonly<Record<string, PreparedReleaseModule>>;
  readonly assets: ReadonlyArray<PreparedReleaseAsset>;
}

export interface CodexReleasePlan extends PlanBase {
  readonly harness: "codex";
  readonly componentManifestPaths: { readonly codex: string };
  readonly engineModule: string;
  readonly loaderModule: string;
  readonly abiVersion: 1;
  readonly target: "wasm32-wasip1";
  readonly upstreamCommit: string;
  readonly moduleBudgetBytes: number;
}

export interface ReleaseEntrypoint {
  readonly module: string;
  readonly export: string;
}

export interface ClaudeReleasePlan extends PlanBase {
  readonly harness: "claude-code";
  readonly componentManifestPaths: { readonly cli: string; readonly sdk: string };
  readonly main: ReleaseEntrypoint;
  readonly initialize: ReleaseEntrypoint;
  readonly embeddedEntrypointExport: string;
  readonly embeddedEntrypoints: Readonly<Record<string, string>>;
  readonly hostEntrypoints: Readonly<Record<string, string>>;
  readonly moduleMaps: ReadonlyArray<PreparedReleaseFile>;
  readonly requiredHostModules: {
    readonly cli: ReadonlyArray<string>;
    readonly sdk: ReadonlyArray<string>;
  };
  readonly environmentPackageModules: Readonly<Record<string, ReleaseFile>>;
  readonly cli: {
    readonly provider: "claude-code";
    readonly version: string;
    readonly platform: string;
    readonly binarySha256: string;
  };
  readonly sdk: {
    readonly provider: "agent-sdk";
    readonly name: "@anthropic-ai/claude-agent-sdk";
    readonly version: string;
    readonly integrity: string;
    readonly tarballSha256: string;
  };
}

export type HarnessReleasePlan = CodexReleasePlan | ClaudeReleasePlan;
