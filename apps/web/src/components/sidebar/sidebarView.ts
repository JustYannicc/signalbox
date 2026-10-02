import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";

/**
 * Which panel the thread sidebar shows next to the view rail. Home is the
 * project tree, Pipeline is the attention-ordered list. Spaces, Automations
 * and Plugins are UI prototypes over placeholder data for now.
 */
export const SidebarView = Schema.Literals([
  "home",
  "spaces",
  "automations",
  "pipeline",
  "plugins",
]);
export type SidebarView = typeof SidebarView.Type;

const SIDEBAR_VIEW_STORAGE_KEY = "t3code:sidebar:view";

export function useSidebarView() {
  return useLocalStorage<SidebarView, SidebarView>(SIDEBAR_VIEW_STORAGE_KEY, "home", SidebarView);
}

/** Pages that belong to a view; landing on one opens its panel. */
export function sidebarViewForPathname(pathname: string): SidebarView | null {
  // Pull requests open from the Spaces panel, so they keep it lit.
  if (pathname === "/spaces" || pathname === "/pull-requests") return "spaces";
  if (pathname === "/plugins") return "plugins";
  if (pathname === "/automations" || pathname.startsWith("/automations/")) return "automations";
  return null;
}
