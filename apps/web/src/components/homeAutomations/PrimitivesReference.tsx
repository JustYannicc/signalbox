/**
 * `/automations`: the reference of every hook a workflow can start from and
 * every step it can use, linked from the add-step palette. Automations
 * themselves live in Home folders. Inline hooks are marked with the latency
 * they add, since they sit in the path of the thing they intercept.
 */
import { createElement } from "react";

import { isElectron } from "../../env";
import { Badge } from "../ui/badge";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  HOOK_GROUPS,
  STEP_GROUPS,
  type HookPrimitive,
  type PrimitiveGroup,
  type StepPrimitive,
} from "./primitiveCatalog";

function PrimitiveItem(props: { item: HookPrimitive | StepPrimitive }) {
  const { item } = props;
  const hook = "mode" in item ? item : null;
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {createElement(item.icon, { "aria-hidden": true, className: "size-3.5" })}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-foreground">{item.label}</span>
          {hook ? (
            <Badge variant={hook.mode === "inline" ? "warning" : "secondary"} size="sm">
              {hook.mode === "inline" ? "Inline" : "Async"}
            </Badge>
          ) : null}
        </span>
        <span className="text-sm text-pretty text-muted-foreground">
          {item.description}
          {hook?.budget ? ` Latency: ${hook.budget}.` : ""}
        </span>
      </div>
      {hook ? (
        <code className="hidden shrink-0 pt-0.5 font-mono text-xs text-muted-foreground md:block">
          {hook.id}
        </code>
      ) : null}
    </li>
  );
}

function Groups<T extends HookPrimitive | StepPrimitive>(props: {
  groups: readonly PrimitiveGroup<T>[];
}) {
  return props.groups.map((group) => (
    <section key={group.title} className="flex flex-col">
      <h3 className="text-xs font-medium text-muted-foreground">{group.title}</h3>
      <ul className="flex flex-col divide-y">
        {group.items.map((item) => (
          <PrimitiveItem key={item.id} item={item} />
        ))}
      </ul>
    </section>
  ));
}

function PrimitivesReference() {
  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="primitives-triggers" className="flex flex-col gap-5">
        <h2 id="primitives-triggers" className="text-base font-semibold text-foreground">
          Triggers and hooks
        </h2>
        <Groups groups={HOOK_GROUPS} />
      </section>
      <section aria-labelledby="primitives-steps" className="flex flex-col gap-5">
        <h2 id="primitives-steps" className="text-base font-semibold text-foreground">
          Steps
        </h2>
        <Groups groups={STEP_GROUPS} />
      </section>
    </div>
  );
}

export function PrimitivesReferencePage() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Automations breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <h1>Triggers and steps</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer>
            <PrimitivesReference />
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
