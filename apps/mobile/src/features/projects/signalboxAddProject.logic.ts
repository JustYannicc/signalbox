/** signalbox: which Add project sources an environment offers (see `signalboxCapabilities.ts`). */
import type { AddProjectRemoteSource } from "@t3tools/client-runtime/operations/projects";
import {
  type ExecutionEnvironmentCapabilities,
  type SourceControlProviderKind,
  environmentImportsFrom,
  environmentSupports,
} from "@t3tools/contracts";

export interface AddProjectSourceSupport {
  /** Local folder, and browsing for a clone's destination, through `filesystem.browse`. */
  readonly localFilesystem: boolean;
  /** The generic "Git URL" source. */
  readonly cloneFromUrl: boolean;
  /** The hosts it imports repositories from; null for every host. */
  readonly sourceControlImports: ReadonlyArray<string> | null;
}

export function addProjectSourceSupport(
  capabilities:
    | Pick<
        ExecutionEnvironmentCapabilities,
        "localFilesystem" | "cloneFromUrl" | "sourceControlImports"
      >
    | null
    | undefined,
): AddProjectSourceSupport {
  return {
    localFilesystem: environmentSupports(capabilities, "localFilesystem"),
    cloneFromUrl: environmentSupports(capabilities, "cloneFromUrl"),
    sourceControlImports: capabilities?.sourceControlImports ?? null,
  };
}

/**
 * Clone sources in picker order: "Git URL" first where the environment clones
 * any URL, then the hosts it imports from.
 */
export function addProjectCloneSources(
  providers: ReadonlyArray<SourceControlProviderKind>,
  support: Pick<AddProjectSourceSupport, "cloneFromUrl" | "sourceControlImports">,
): ReadonlyArray<AddProjectRemoteSource> {
  const imported = providers.filter((provider) =>
    environmentImportsFrom(
      support.sourceControlImports === null
        ? null
        : { sourceControlImports: support.sourceControlImports },
      provider,
    ),
  );
  return support.cloneFromUrl ? ["url", ...imported] : imported;
}
