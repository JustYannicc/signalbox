/**
 * The thread sidebar with a view rail. The rail runs down the left edge and
 * never collapses; collapsing the sidebar hides only the panel beside it
 * (the sidebar's `icon` collapse, whose icon width is the rail's width). The
 * panel holds the titlebar row, New chat and the assistant, then the chosen
 * view. Pipeline is the existing attention-ordered sidebar, rendered unchanged
 * apart from its titlebar, which this layout owns.
 *
 * Spaces, Plugins and Automations own pages; picking one opens its page, and
 * landing on a page opens its panel. Leaving for Home or Pipeline from one of
 * those pages returns to the last thread. Pull requests count as a Spaces
 * page, so picking Spaces there stays put. Settings keeps the rail and shows
 * its own navigation in the panel.
 */
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback, type ReactNode } from "react";

import { isElectron } from "../../env";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import ThreadSidebar from "../Sidebar";
import { SidebarStageBackdrop, useSidebarStageBackdropVariant } from "../SidebarStageBackdrop";
import { AutomationsSidebar } from "./AutomationsSidebar";
import { HomeSidebar } from "./HomeSidebar";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { PluginsSidebar } from "./PluginsSidebar";
import { SidebarChromeHeader, SidebarRailContext } from "./SidebarChrome";
import { SidebarQuickActions } from "./SidebarQuickActions";
import { SidebarViewRail } from "./SidebarViewRail";
import { SpacesSidebar } from "./SpacesSidebar";
import { sidebarViewForPathname, useSidebarView, type SidebarView } from "./sidebarView";

function PipelineSidebar() {
  return (
    <>
      <div className="shrink-0 px-2 pt-2">
        <h2 className="flex h-8 items-center px-2.5 text-base font-semibold tracking-tight text-sidebar-foreground">
          Pipeline
        </h2>
      </div>
      <ThreadSidebar showChromeHeader={false} />
    </>
  );
}

const VIEW_PAGES = {
  spaces: "/spaces",
  plugins: "/plugins",
  automations: "/automations",
} as const satisfies Partial<Record<SidebarView, string>>;

function SidebarViewPanel(props: { view: SidebarView }) {
  switch (props.view) {
    case "home":
      return <HomeSidebar />;
    case "spaces":
      return <SpacesSidebar />;
    case "automations":
      return <AutomationsSidebar />;
    case "plugins":
      return <PluginsSidebar />;
    case "pipeline":
      return <PipelineSidebar />;
  }
}

export function SidebarViews(props: {
  /** Replaces the view panel, e.g. the settings navigation. */
  panelOverride?: ReactNode;
}) {
  const [storedView, setStoredView] = useSidebarView();
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const pathname = useLocation({ select: (location) => location.pathname });
  const routeView = sidebarViewForPathname(pathname);
  const view = routeView ?? storedView;
  // Utility pages (settings, usage, devices…) light up their own rail button instead.
  const highlightedView = routeView ?? (isSidebarUtilityPage(pathname) ? null : storedView);
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = useSidebarStageBackdropVariant(
    environmentIdentificationMode === "artwork",
  );

  const changeView = useCallback(
    (next: SidebarView) => {
      setStoredView(next);
      if (next === "spaces" || next === "plugins" || next === "automations") {
        if (routeView !== next) void navigate({ to: VIEW_PAGES[next] });
      } else if (routeView !== null || isSidebarUtilityPage(pathname)) {
        void navigateToMainApp();
      }
    },
    [navigate, navigateToMainApp, pathname, routeView, setStoredView],
  );

  return (
    <SidebarRailContext value>
      <div className="relative flex h-full min-h-0">
        {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
        <div className="relative flex w-12 shrink-0 flex-col">
          {/* Clears the window controls; draggable like the rest of the titlebar. */}
          <div
            aria-hidden
            className={
              isElectron
                ? "drag-region h-[var(--workspace-topbar-height)] shrink-0"
                : "h-[var(--workspace-topbar-height)] shrink-0"
            }
          />
          <SidebarViewRail view={highlightedView} onViewChange={changeView} />
        </div>
        <div className="relative flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
          <SidebarChromeHeader isElectron={isElectron} />
          <div
            className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-tl-xl border-t border-l border-sidebar-border bg-sidebar"
            data-sidebar-view={view}
          >
            {/* Settings' own navigation replaces the panel; New and the assistant step aside. */}
            {props.panelOverride ?? (
              <>
                <SidebarQuickActions />
                <SidebarViewPanel view={view} />
              </>
            )}
          </div>
        </div>
      </div>
    </SidebarRailContext>
  );
}
