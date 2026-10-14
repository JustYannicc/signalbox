/** signalbox: which Add project sources an environment offers (see `signalboxCapabilities.ts`). */
import type { AddProjectRemoteSource } from "@t3tools/client-runtime/operations/projects";
import {
  type ExecutionEnvironmentCapabilities,
  type SourceControlProviderKind,
  environmentSupports,
} from "@t3tools/contracts";

export interface AddProjectSourceSupport {
  /** Local folder, and browsing for a clone's destination, through `filesystem.browse`. */
  readonly localFilesystem: boolean;
  /** The generic "Git URL" source. */
  readonly cloneFromUrl: boolean;
}

export function addProjectSourceSupport(
  capabilities:
    | Pick<ExecutionEnvironmentCapabilities, "localFilesystem" | "cloneFromUrl">
    | null
    | undefined,
): AddProjectSourceSupport {
  return {
    localFilesystem: environmentSupports(capabilities, "localFilesystem"),
    cloneFromUrl: environmentSupports(capabilities, "cloneFromUrl"),
  };
}

/** Clone sources in picker order: "Git URL" first where the environment clones any URL. */
export function addProjectCloneSources(
  providers: ReadonlyArray<SourceControlProviderKind>,
  support: Pick<AddProjectSourceSupport, "cloneFromUrl">,
): ReadonlyArray<AddProjectRemoteSource> {
  return support.cloneFromUrl ? ["url", ...providers] : providers;
}
