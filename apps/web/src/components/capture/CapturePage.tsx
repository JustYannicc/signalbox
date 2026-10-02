/**
 * `/capture` (Settings › Workspace › Capture): the default capture workflow,
 * ways to open New, and recent captures with where they went. Placeholder data.
 */
import { useAtomValue } from "@effect/atom-react";
import { PlusIcon } from "lucide-react";

import { isElectron } from "../../env";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { CaptureSettingsPanel } from "./CaptureSettingsPanel";
import { openQuickCapture } from "./captureModel";
import { RecentCaptures } from "./RecentCaptures";

export function CapturePage() {
  const shortcut = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "capture.open",
  );
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Capture breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <h1>Capture</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="ms-auto">
            <Button size="xs" variant="outline" onClick={() => openQuickCapture()}>
              <PlusIcon />
              New
              {shortcut ? <Kbd>{shortcut}</Kbd> : null}
            </Button>
          </div>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer>
            <CaptureSettingsPanel />
            <section aria-labelledby="capture-recent" className="flex flex-col gap-2">
              <h2 id="capture-recent" className="text-sm font-medium text-foreground">
                Recent
              </h2>
              <RecentCaptures />
            </section>
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
