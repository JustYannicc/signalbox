/**
 * The frame every automations page shares: the header with its breadcrumb and
 * controls, then the page body. "Automations" in the breadcrumb leads to the
 * overview and brings the Automations panel into the sidebar.
 */
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { isElectron } from "../../env";
import { useSidebarView } from "../sidebar/sidebarView";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

export function AutomationsPageShell(props: {
  /** The automation's name; null on the overview, or while it loads. */
  title: string | null;
  /** True on the overview, where "Automations" is the page itself. */
  overview?: boolean;
  header?: ReactNode;
  children: ReactNode;
}) {
  const [, setView] = useSidebarView();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Automations breadcrumb" className="min-w-0 shrink">
            {props.overview ? (
              <WorkspaceBreadcrumbItem current>
                <h1>
                  <WorkspaceBreadcrumbText>Automations</WorkspaceBreadcrumbText>
                </h1>
              </WorkspaceBreadcrumbItem>
            ) : (
              <WorkspaceBreadcrumbItem>
                <Link
                  to="/automations"
                  className="hover:text-foreground"
                  onClick={() => setView("automations")}
                >
                  <WorkspaceBreadcrumbText>Automations</WorkspaceBreadcrumbText>
                </Link>
              </WorkspaceBreadcrumbItem>
            )}
            {props.title ? (
              <>
                <WorkspaceBreadcrumbSeparator />
                <WorkspaceBreadcrumbItem current className="min-w-10">
                  <h1 className="min-w-0">
                    <WorkspaceBreadcrumbText>{props.title}</WorkspaceBreadcrumbText>
                  </h1>
                </WorkspaceBreadcrumbItem>
              </>
            ) : null}
          </WorkspaceBreadcrumb>
          {props.header}
        </WorkspacePageHeader>
        {props.children}
      </div>
    </SidebarInset>
  );
}
