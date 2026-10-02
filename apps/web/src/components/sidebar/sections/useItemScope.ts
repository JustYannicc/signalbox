/**
 * The scope marker for one Home row, from the shared access model: visibility
 * and direct grants (as changed in the Share dialog) measured against the
 * container's default. `null` deviation means the row shows nothing.
 */
import { useAccessItem, type AccessItemBase } from "../../multiplayer/itemAccess";
import { peopleWithAccess, scopeDeviation, type ScopeDeviation } from "../../multiplayer/sharing";

export interface ItemScope {
  readonly deviation: ScopeDeviation | null;
  /** People besides you who can see it; shown for shared-in-private items. */
  readonly othersCount: number;
}

export function useItemScope(base: AccessItemBase): ItemScope {
  const item = useAccessItem(base);
  const deviation = scopeDeviation(item);
  return {
    deviation,
    othersCount: deviation === "shared-in-private" ? peopleWithAccess(item).length - 1 : 0,
  };
}
