import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { useLocalStorage } from "../../hooks/useLocalStorage";

/**
 * Which panel the sidebar shows next to the view rail. Home is the project
 * tree, Pipeline is the attention-ordered thread list. Only views that run on
 * real data belong here. Automations have no view of their own: they belong in
 * their folders (#313).
 */
export const SidebarView = Schema.Literals(["home", "pipeline"]);
export type SidebarView = typeof SidebarView.Type;

const SIDEBAR_VIEW_STORAGE_KEY = "t3code:sidebar:view";

/**
 * Views that no longer exist ("spaces", "automations") open Home. Without
 * this, they'd also land on Home, but through a logged decode failure.
 */
export const StoredSidebarView = Schema.Literals([
  "home",
  "spaces",
  "automations",
  "pipeline",
]).pipe(
  Schema.decodeTo(
    SidebarView,
    SchemaTransformation.transform({
      decode: (view) => (view === "pipeline" ? "pipeline" : "home"),
      encode: (view) => view,
    }),
  ),
);

export function useSidebarView() {
  return useLocalStorage(SIDEBAR_VIEW_STORAGE_KEY, "home" as SidebarView, StoredSidebarView);
}
