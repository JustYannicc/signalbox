/**
 * `/automations` with nothing picked: a calm digest of the runs that need you
 * (approvals, failures), or an empty state when nothing does. The list of
 * automations lives in the sidebar. `?view=primitives` shows every hook and
 * step a workflow can use.
 */
import { Link, useNavigate } from "@tanstack/react-router";

import { isElectron } from "../../env";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { formatRunStarted } from "./automationFormat";
import type { AutomationAttentionItem } from "./automationStatus";
import { PrimitivesReference } from "./PrimitivesReference";
import { useAutomationAttention, useAutomations } from "./runDecisions";
import { RunStatusMarker } from "./RunStatusMarker";
import { useAssistantName } from "./useAssistantName";
import { WorkflowAgentAvatar } from "./WorkflowAgent";

function AttentionRow({ item }: { item: AutomationAttentionItem }) {
  const nameText = useAssistantName();
  return (
    <li>
      <Link
        to="/automations/$automationId"
        params={{ automationId: item.automation.id }}
        search={{ run: item.run.id }}
        className="flex items-center gap-3 rounded-lg px-3 py-2.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <WorkflowAgentAvatar automation={item.automation} size={28} className="shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-foreground">
            {nameText(item.run.title)}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {nameText(item.automation.name)} · {formatRunStarted(item.run)}
          </span>
        </span>
        <RunStatusMarker status={item.status} />
      </Link>
    </li>
  );
}

function NeedsYouDigest() {
  const items = useAutomationAttention();
  const automations = useAutomations();
  if (items.length === 0) {
    const running = automations.filter((automation) => automation.enabled).length;
    return (
      <div className="flex flex-col items-center gap-1 py-24 text-center">
        <p className="text-sm font-medium text-foreground">Nothing needs you</p>
        <p className="text-sm text-muted-foreground">{running} automations running quietly.</p>
      </div>
    );
  }
  return (
    <section aria-labelledby="automations-needs-you" className="flex flex-col gap-1">
      <h2 id="automations-needs-you" className="px-3 text-xs font-medium text-muted-foreground">
        Needs you
      </h2>
      <ul className="flex flex-col">
        {items.map((item) => (
          <AttentionRow key={item.run.id} item={item} />
        ))}
      </ul>
    </section>
  );
}

export function AutomationsOverviewPage(props: { view: "automations" | "primitives" }) {
  const navigate = useNavigate();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Automations breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <h1>Automations</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="ms-auto">
            <ToggleGroup
              aria-label="Automations view"
              variant="segmented"
              value={[props.view]}
              onValueChange={(next) =>
                void navigate({
                  to: "/automations",
                  search: next[0] === "primitives" ? { view: "primitives" } : {},
                })
              }
            >
              <Toggle value="automations">Needs you</Toggle>
              <Toggle value="primitives">Primitives</Toggle>
            </ToggleGroup>
          </div>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer>
            {props.view === "primitives" ? <PrimitivesReference /> : <NeedsYouDigest />}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
