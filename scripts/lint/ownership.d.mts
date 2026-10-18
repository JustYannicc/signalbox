export type LintOwnershipOptions = {
  readonly cwd: string;
  readonly head?: string;
  readonly upstreamRef?: string;
};

export type LintOwnershipResult = {
  readonly commit: string;
  readonly upstreamOwnedFiles: readonly string[];
};

export function readLintOwnership(options: LintOwnershipOptions): LintOwnershipResult;

export function escapeOxlintFileGlob(filePath: string): string;
