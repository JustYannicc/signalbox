/**
 * `/setup`: agent-first onboarding. The preferred path is copying one prompt
 * into the coding agent the user already has; the CLI, MCP, and skill below
 * are what that prompt installs. Placeholder data; nothing is installed yet.
 */
import { isElectron } from "../../env";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SetupChecklist } from "./SetupChecklist";
import { SetupPromptBlock } from "./SetupPromptBlock";
import { SetupSurfaces } from "./SetupSurfaces";
import { PRODUCT_NAME } from "./setupFixtures";

export function SetupPage() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Setup breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current>Setup</WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide" className="gap-10">
            <div className="flex max-w-2xl flex-col gap-2 pt-4">
              <h1 className="text-2xl font-semibold text-balance text-foreground">
                Let your agent set this up
              </h1>
              <p className="text-sm text-pretty text-muted-foreground">
                One prompt installs {PRODUCT_NAME}, connects your accounts, and proves it works. You
                only step in to sign in and answer a few questions.
              </p>
            </div>
            <SetupPromptBlock />
            <SetupChecklist />
            <SetupSurfaces />
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
