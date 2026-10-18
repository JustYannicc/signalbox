import { matchRepositories } from "@t3tools/client-runtime/state/signalboxRepositories";
import type { EnvironmentId, SourceControlProviderKind } from "@t3tools/contracts";
import { type ReactNode, useEffect, useRef } from "react";

import { useRepositoriesToPick } from "../../state/signalboxRepositories";
import type { CommandPaletteGroup } from "../CommandPalette.logic";

/** More than this is noise in a palette; typing narrows it. */
const MAX_SHOWN = 50;
const NO_GROUPS: ReadonlyArray<CommandPaletteGroup> = [];

/**
 * "Add project" › a provider's repository step: the account's repositories
 * as palette items, narrowed by what's typed. Picking one looks it up the same
 * way typing its name and pressing Enter does. Empty where the server can't
 * list them, which leaves the typed name as the only way.
 *
 * The groups keep their identity until the list or the query changes: the
 * palette hands their values to Base UI, which re-highlights (and so
 * re-renders the palette) whenever it gets a new array.
 */
export function useRepositoryPickerGroups(input: {
  readonly environmentId: EnvironmentId | null;
  readonly provider: SourceControlProviderKind | null;
  readonly query: string;
  /** Keep it stable (memoize it): a new icon rebuilds the groups. */
  readonly icon: ReactNode;
  readonly onPick: (nameWithOwner: string) => void;
}): ReadonlyArray<CommandPaletteGroup> {
  const { icon, query } = input;
  const repositories = useRepositoriesToPick(input.environmentId, input.provider);
  // The newest callback, without making the groups change with every render.
  const onPick = useRef(input.onPick);
  useEffect(() => {
    onPick.current = input.onPick;
  });
  return (() => {
    if (repositories === null) return NO_GROUPS;
    const matches = matchRepositories(repositories, query).slice(0, MAX_SHOWN);
    if (matches.length === 0) return NO_GROUPS;
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
          run: async () => onPick.current(repository.nameWithOwner),
        })),
      },
    ];
  })();
}
