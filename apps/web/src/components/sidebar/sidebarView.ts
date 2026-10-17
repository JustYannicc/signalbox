import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { useLocalStorage } from "../../hooks/useLocalStorage";

/**
 * Which panel the sidebar shows next to the view rail. Home is the folder
 * tree. Only views that run on real data belong here. Automations have no view
 * of their own: they belong in their folders (#313). Pipeline comes back as
 * the pipeline rounds (#309), not upstream's attention-ordered list (#683).
 */
export const SidebarView = Schema.Literals(["home"]);
export type SidebarView = typeof SidebarView.Type;

const SIDEBAR_VIEW_STORAGE_KEY = "t3code:sidebar:view";

/**
 * Views that no longer exist ("spaces", "automations", "pipeline") open Home.
 * Without this, they'd also land on Home, but through a logged decode failure.
 */
const SavedSidebarView = Schema.Literals(["home", "spaces", "automations", "pipeline"]);

export const StoredSidebarView = SavedSidebarView.pipe(
  Schema.decodeTo(
    SidebarView,
    SchemaTransformation.transform({
      decode: () => "home" as const,
      encode: (view): typeof SavedSidebarView.Type => view,
    }),
  ),
);

export function useSidebarView() {
  return useLocalStorage(SIDEBAR_VIEW_STORAGE_KEY, "home" as SidebarView, StoredSidebarView);
}
