/**
 * signalbox: whether Add project can start yet. Right after sign-in the
 * environments are still connecting (on Signalbox Cloud, every time), and
 * sending the user to connection settings then would be wrong: they have an
 * environment, it just isn't ready. Clients wait instead and continue once one
 * connects.
 */
import {
  type ExecutionEnvironmentCapabilities,
  type SourceControlProviderKind,
  environmentImportsFrom,
  environmentSupports,
} from "@t3tools/contracts";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import type { AddProjectRemoteSource } from "./projects.ts";

/** `unavailable`: nothing is connected or on its way, so the user has to connect something. */
export type AddProjectAvailability = "ready" | "connecting" | "unavailable";

export function resolveAddProjectAvailability(input: {
  readonly catalogReady: boolean;
  readonly phases: ReadonlyArray<EnvironmentConnectionPhase>;
}): AddProjectAvailability {
  if (input.phases.includes("connected")) return "ready";
  if (
    !input.catalogReady ||
    input.phases.includes("connecting") ||
    input.phases.includes("reconnecting")
  ) {
    return "connecting";
  }
  return "unavailable";
}

type SourceCapabilities = Pick<
  ExecutionEnvironmentCapabilities,
  "localFilesystem" | "cloneFromUrl" | "sourceControlImports"
>;

/** Which Add project sources an environment offers (see `signalboxCapabilities.ts` in contracts). */
export interface AddProjectSourceSupport {
  /** Local folder, and browsing for a clone's destination, through `filesystem.browse`. */
  readonly localFilesystem: boolean;
  /** The generic "Git URL" source. */
  readonly cloneFromUrl: boolean;
  /** The hosts it imports repositories from; every host when absent. */
  readonly sourceControlImports?: ReadonlyArray<SourceControlProviderKind>;
}

export function addProjectSourceSupport(
  capabilities: SourceCapabilities | null | undefined,
): AddProjectSourceSupport {
  return {
    localFilesystem: environmentSupports(capabilities, "localFilesystem"),
    cloneFromUrl: environmentSupports(capabilities, "cloneFromUrl"),
    ...(capabilities?.sourceControlImports
      ? { sourceControlImports: capabilities.sourceControlImports }
      : {}),
  };
}

/**
 * Clone sources in picker order: "Git URL" first where the environment clones
 * any URL, then the hosts it imports from. Without "Git URL", the hosts'
 * own sources still take a pasted URL.
 */
export function addProjectCloneSources(
  providers: ReadonlyArray<SourceControlProviderKind>,
  support: Pick<AddProjectSourceSupport, "cloneFromUrl" | "sourceControlImports">,
): ReadonlyArray<AddProjectRemoteSource> {
  const imported = providers.filter((provider) => environmentImportsFrom(support, provider));
  return support.cloneFromUrl ? ["url", ...imported] : imported;
}
