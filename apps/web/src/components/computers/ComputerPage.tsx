import { Link } from "@tanstack/react-router";

import { isElectron } from "../../env";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ComputerSessionPanel } from "./ComputerSessionPanel";
import { findComputer } from "./computerFixtures";

export function ComputerPage({ computerId }: { readonly computerId: string }) {
  const computer = findComputer(computerId);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Computer breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem>
              <Link to="/computers" className="hover:text-foreground">
                Computers
              </Link>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="min-w-0">
              <WorkspaceBreadcrumbText>{computer?.name ?? "Not found"}</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded">
            {computer ? (
              <ComputerSessionPanel key={computer.id} computer={computer} />
            ) : (
              <div className="flex flex-col items-start gap-2 py-12">
                <h1 className="text-base font-semibold">No computer with that id</h1>
                <p className="text-sm text-muted-foreground">
                  It may have been released and cleaned up.{" "}
                  <Link to="/computers" className="text-foreground underline underline-offset-4">
                    See all computers
                  </Link>
                </p>
              </div>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
