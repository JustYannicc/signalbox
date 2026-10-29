export interface ClaudeComponentVersionSource {
  readonly harness: string;
  readonly cli?: { readonly version: string };
  readonly sdk?: { readonly version: string };
}

export interface ClaudeComponentVersions {
  readonly cli: string;
  readonly sdk: string;
}

/** Reads exact versions from both verified candidate component manifests. */
export function derivePairedClaudeComponentVersions(
  baseline: ClaudeComponentVersionSource,
  hooks: ClaudeComponentVersionSource,
): ClaudeComponentVersions {
  if (
    baseline.harness !== "claude-code" ||
    hooks.harness !== "claude-code" ||
    baseline.cli === undefined ||
    baseline.sdk === undefined ||
    hooks.cli === undefined ||
    hooks.sdk === undefined
  )
    throw new Error("CLAUDE_QUALIFICATION_COMPONENT_PROVENANCE_INVALID");

  const versions = { cli: baseline.cli.version, sdk: baseline.sdk.version };
  if (versions.cli !== hooks.cli.version || versions.sdk !== hooks.sdk.version)
    throw new Error("CLAUDE_QUALIFICATION_COMPONENT_VERSIONS_MISMATCH");
  return versions;
}
