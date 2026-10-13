/** The repositories "Add project" offers to pick from (Signalbox Cloud). */
import { createSignalboxRepositoriesAtoms } from "@t3tools/client-runtime/state/signalboxRepositories";
import type { EnvironmentId, SourceControlProviderKind } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

const signalboxRepositories = createSignalboxRepositoriesAtoms(connectionAtomRuntime);

/** The connected account's repositories on `provider`; null while loading or where the server can't list. */
export function useRepositoriesToPick(
  environmentId: EnvironmentId | null,
  provider: SourceControlProviderKind | null,
) {
  return (
    useEnvironmentQuery(
      environmentId !== null && provider !== null
        ? signalboxRepositories.list({ environmentId, input: { provider } })
        : null,
    ).data?.repositories ?? null
  );
}
