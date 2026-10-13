import { matchRepositories } from "@t3tools/client-runtime/state/signalboxRepositories";
import type { EnvironmentId, SourceControlProviderKind } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { useRepositoriesToPick } from "../../state/signalboxRepositories";
import type { CommandPaletteGroup } from "../CommandPalette.logic";

/** More than this is noise in a palette; typing narrows it. */
const MAX_SHOWN = 50;

/**
 * "Add project" › a provider's repository step: the account's repositories
 * as palette items, narrowed by what's typed. Picking one looks it up the same
 * way typing its name and pressing Enter does. Empty where the server can't
 * list them, which leaves the typed name as the only way. Not memoized: the
 * palette rebuilds its rows every render anyway, and this is one page of names.
 */
export function useRepositoryPickerGroups(input: {
  readonly environmentId: EnvironmentId | null;
  readonly provider: SourceControlProviderKind | null;
  readonly query: string;
  readonly icon: ReactNode;
  readonly onPick: (nameWithOwner: string) => void;
}): ReadonlyArray<CommandPaletteGroup> {
  const { icon, onPick, query } = input;
  const repositories = useRepositoriesToPick(input.environmentId, input.provider);
  if (repositories === null) return [];
  const matches = matchRepositories(repositories, query).slice(0, MAX_SHOWN);
  if (matches.length === 0) return [];
  return [
    {
      value: "repositories",
      label: "Your repositories",
      items: matches.map((repository) => ({
        kind: "action" as const,
        value: `repository:${repository.nameWithOwner}`,
        searchTerms: [repository.nameWithOwner],
        title: repository.nameWithOwner,
        icon,
        keepOpen: true,
        run: async () => onPick(repository.nameWithOwner),
      })),
    },
  ];
}
