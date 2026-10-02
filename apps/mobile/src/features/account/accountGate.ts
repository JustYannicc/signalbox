import { useAtomValue } from "@effect/atom-react";

import { environmentCatalog } from "../../connection/catalog";

/**
 * Mobile runs no server of its own, so a device with no saved environment has
 * nothing to show until someone signs in (or pairs). Home renders the sign-in
 * screen in that state and the split-view sidebar stays closed. Disabled
 * environments still count: they are saved and can be switched back on.
 */
export function useNeedsAccountSignIn(): boolean {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  return catalog.isReady && catalog.entries.size === 0;
}
