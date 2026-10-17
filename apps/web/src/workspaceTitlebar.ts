// --workspace-titlebar-content-left is measured from the window edge, but a
// collapsed rail layout keeps its rail on screen and main content starts after
// it, so collapsed headers take the rail's width back off.
export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS =
  "[[data-sidebar-state=collapsed]_&]:pl-[calc(var(--workspace-titlebar-content-left)-var(--workspace-collapsed-rail-width,0px))] max-md:[[data-sidebar-state=expanded]_&]:pl-[var(--workspace-titlebar-content-left)]";

/**
 * Width the collapsed sidebar keeps beside main content. Only the rail layout
 * keeps one, and only at desktop widths; below them the sidebar is a sheet.
 */
export function resolveCollapsedRailWidth(input: {
  isMobile: boolean;
  railLayout: boolean;
}): string | undefined {
  return input.railLayout && !input.isMobile ? "var(--sidebar-width-icon)" : undefined;
}
