/**
 * The sidebar with a view rail. The rail runs down the left edge and never
 * collapses; collapsing the sidebar hides only the panel beside it (the
 * sidebar's `icon` collapse, whose icon width is the rail's width).
 *
 * Home is upstream's project tree and Pipeline is upstream's attention-ordered
 * list, both rendered unchanged apart from their titlebar row, which this
 * layout owns (see SidebarRailContext). Settings keeps the rail and shows its
 * own navigation in the panel. Picking a view from a utility page (settings,
 * usage, pull requests) returns to the last thread.
 */
import { useLocation } from "@tanstack/react-router";
import { useCallback, type ReactNode } from "react";

import { isElectron } from "../../env";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { SidebarStageBackdrop, useSidebarStageBackdropVariant } from "../SidebarStageBackdrop";
import { HomeNewButton } from "./HomeNewButton";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarChromeHeader, SidebarRailContext } from "./SidebarChrome";
import { SidebarViewRail } from "./SidebarViewRail";
import { useSidebarView, type SidebarView } from "./sidebarView";

const VIEW_TITLES: Record<SidebarView, string> = { home: "Home", pipeline: "Pipeline" };

function SidebarViewPanel(props: { view: SidebarView; home: ReactNode; pipeline: ReactNode }) {
  return (
    <>
      <div className="shrink-0 px-2 pt-2">
        <h2 className="flex h-8 items-center px-2.5 text-base font-semibold tracking-tight text-sidebar-foreground">
          {VIEW_TITLES[props.view]}
        </h2>
      </div>
      {props.view === "home" ? (
        <>
          <HomeNewButton />
          {props.home}
        </>
      ) : (
        props.pipeline
      )}
    </>
  );
}

export function SidebarViews(props: {
  /** Upstream's project-tree sidebar. */
  home: ReactNode;
  /** Upstream's attention-ordered sidebar. */
  pipeline: ReactNode;
  /** Replaces the view panel, e.g. the settings navigation. */
  panelOverride?: ReactNode;
}) {
  const [view, setView] = useSidebarView();
  const navigateToMainApp = useNavigateToMainApp();
  const onUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = useSidebarStageBackdropVariant(
    environmentIdentificationMode === "artwork",
  );

  const changeView = useCallback(
    (next: SidebarView) => {
      setView(next);
      if (onUtilityPage) void navigateToMainApp();
    },
    [navigateToMainApp, onUtilityPage, setView],
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
          {/* Utility pages light up their own rail button instead of a view. */}
          <SidebarViewRail view={onUtilityPage ? null : view} onViewChange={changeView} />
        </div>
        <div className="relative flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
          <SidebarChromeHeader isElectron={isElectron} inRail />
          <div
            className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-tl-xl border-t border-l border-sidebar-border bg-sidebar"
            data-sidebar-view={view}
          >
            {props.panelOverride ?? (
              <SidebarViewPanel view={view} home={props.home} pipeline={props.pipeline} />
            )}
          </div>
        </div>
      </div>
    </SidebarRailContext>
  );
}
