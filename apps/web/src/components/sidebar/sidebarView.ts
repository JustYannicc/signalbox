import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";

/**
 * Which panel the sidebar shows next to the view rail. Home is the project
 * tree, Pipeline is the attention-ordered thread list, Automations lists the
 * user's automations. Only views that run on real data belong here; the rest
 * sit in the rail as "coming soon".
 */
export const SidebarView = Schema.Literals(["home", "automations", "pipeline"]);
export type SidebarView = typeof SidebarView.Type;

const SIDEBAR_VIEW_STORAGE_KEY = "t3code:sidebar:view";

export function useSidebarView() {
  return useLocalStorage<SidebarView, SidebarView>(SIDEBAR_VIEW_STORAGE_KEY, "home", SidebarView);
}
