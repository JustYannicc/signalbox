import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { useLocalStorage } from "../../hooks/useLocalStorage";

/**
 * Which panel the thread sidebar shows next to the view rail. Home is the
 * project tree, Pipeline is the attention-ordered list. Plugins is a UI
 * prototype over placeholder data for now. Automations, accounts and places
 * have no view of their own: they live in Home folders, so their pages keep
 * Home lit.
 */
export const SidebarView = Schema.Literals(["home", "pipeline", "plugins"]);
export type SidebarView = typeof SidebarView.Type;

const SIDEBAR_VIEW_STORAGE_KEY = "t3code:sidebar:view";

/**
 * Spaces and automations folded into Home; a saved "spaces" view, or main's
 * "automations" view, opens Home instead of failing to decode.
 */
const StoredSidebarView = Schema.Literals([
  "home",
  "spaces",
  "automations",
  "pipeline",
  "plugins",
]).pipe(
  Schema.decodeTo(
    SidebarView,
    SchemaTransformation.transform({
      decode: (view) => (view === "spaces" || view === "automations" ? "home" : view),
      encode: (view) => view,
    }),
  ),
);

export function useSidebarView() {
  return useLocalStorage(SIDEBAR_VIEW_STORAGE_KEY, "home" as SidebarView, StoredSidebarView);
}

/** Pages that belong to a view; landing on one opens its panel. */
export function sidebarViewForPathname(pathname: string): SidebarView | null {
  if (pathname === "/plugins") return "plugins";
  // Places, accounts, repositories' pull requests and automations open from Home folders.
  // There is no Automations view, so main's real automation pages keep Home lit too.
  if (
    pathname === "/spaces" ||
    pathname === "/pull-requests" ||
    pathname === "/automations" ||
    pathname.startsWith("/automations/") ||
    pathname === "/home/automations" ||
    pathname.startsWith("/home/automations/")
  ) {
    return "home";
  }
  return null;
}
