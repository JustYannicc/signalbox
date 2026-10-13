import { SIGNALBOX_REPOSITORIES_WS_METHODS } from "@t3tools/contracts/signalboxRepositories";
import type { SourceControlRepositoryInfo } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * The repositories "Add project" offers. Signalbox Cloud lists what the
 * user's connected GitHub reaches; other servers fail, and clients let the
 * user type a name instead.
 */
export function createSignalboxRepositoriesAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Input `{ provider }`. */
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:signalbox-repositories:list",
      tag: SIGNALBOX_REPOSITORIES_WS_METHODS.list,
    }),
  };
}

/** The repositories whose name contains every word typed, keeping their order (most recent first). */
export function matchRepositories(
  repositories: ReadonlyArray<SourceControlRepositoryInfo>,
  query: string,
): ReadonlyArray<SourceControlRepositoryInfo> {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return repositories;
  return repositories.filter((repository) => {
    const name = repository.nameWithOwner.toLowerCase();
    return words.every((word) => name.includes(word));
  });
}
