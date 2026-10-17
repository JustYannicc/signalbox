/**
 * The frame every automations page shares: the header with its breadcrumb and
 * controls, then the page body. An automation's breadcrumb starts with where
 * it lives, its folder path, since automations live in their folders (#313).
 */
import type { ReactNode } from "react";

import { isElectron } from "../../env";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

export function AutomationsPageShell(props: {
  /** The page's name: the automation's, or null while it loads. */
  title: string | null;
  /** Where it lives ("Dev / signalbox"), before the title. */
  home?: string | null;
  header?: ReactNode;
  children: ReactNode;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Automation breadcrumb" className="min-w-0 shrink">
            {props.home ? (
              <>
                <WorkspaceBreadcrumbItem className="min-w-10">
                  <WorkspaceBreadcrumbText>{props.home}</WorkspaceBreadcrumbText>
                </WorkspaceBreadcrumbItem>
                {props.title ? <WorkspaceBreadcrumbSeparator /> : null}
              </>
            ) : null}
            {props.title ? (
              <WorkspaceBreadcrumbItem current className="min-w-10">
                <h1 className="min-w-0">
                  <WorkspaceBreadcrumbText>{props.title}</WorkspaceBreadcrumbText>
                </h1>
              </WorkspaceBreadcrumbItem>
            ) : null}
          </WorkspaceBreadcrumb>
          {props.header}
        </WorkspacePageHeader>
        {props.children}
      </div>
    </SidebarInset>
  );
}
