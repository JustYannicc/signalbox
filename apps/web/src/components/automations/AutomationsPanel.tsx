/**
 * The rail's Automations panel: anything waiting on you first, answerable in
 * place, then automations that are on, then paused ones. A row opens the
 * automation's page and unfolds into its recent runs; each run opens as its
 * chat. Sort, filter and search live in the header.
 */
import {
  automationKey,
  entryKey,
  filterAutomations,
  sortAutomations,
  waitsOnYou,
  type AutomationEntry,
} from "@t3tools/client-runtime/automations/list";
import { useParams, useSearch } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useEnvironments } from "../../state/environments";
import { SidebarChromeFooter } from "../sidebar/SidebarChrome";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SidebarContent, SidebarMenu } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { AutomationSidebarRow } from "./AutomationSidebarRow";
import { AutomationsPanelHeader, useAutomationsPanelPrefs } from "./AutomationsPanelHeader";
import { RailSectionHeader, WaitingAutomationList } from "./AutomationsWaitingGroup";
import { useAllAutomations } from "./useAutomations";

function EmptyAutomations() {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <WorkflowIcon />
        </EmptyMedia>
        <EmptyTitle>No automations yet</EmptyTitle>
        <EmptyDescription>
          Automations do recurring work for you and check in when they need a decision. Ask an agent
          in any thread to automate something.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function AutomationsPanel() {
  const { entries, loading } = useAllAutomations();
  const { environments } = useEnvironments();
  const prefs = useAutomationsPanelPrefs();
  const [query, setQuery] = useState<string | null>(null);
  const activeKey = useParams({
    strict: false,
    select: (params) =>
      "automationId" in params && params.automationId && params.environmentId
        ? automationKey(params.environmentId, params.automationId)
        : null,
  });
  const activeRunId = useSearch({
    strict: false,
    select: (search) => ("run" in search && typeof search.run === "string" ? search.run : null),
  });
  // An automation opened on one of its runs starts unfolded so the run is in sight.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(activeKey && activeRunId ? [activeKey] : []),
  );
  const toggle = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const environmentLabels = useMemo(
    () =>
      environments.length > 1
        ? new Map(environments.map((entry) => [entry.environmentId, entry.label]))
        : null,
    [environments],
  );

  const groups = useMemo(() => {
    const shown = sortAutomations(
      filterAutomations(entries, { query: query ?? "", onlyNeedsYou: prefs.onlyNeedsYou }),
      prefs.sortOrder,
    );
    const waiting = (entry: AutomationEntry) => waitsOnYou(entry.automation);
    return {
      waiting: shown.filter(waiting),
      on: shown.filter((entry) => entry.automation.enabled && !waiting(entry)),
      paused: shown.filter((entry) => !entry.automation.enabled && !waiting(entry)),
    };
  }, [entries, prefs.onlyNeedsYou, prefs.sortOrder, query]);
  const nothingShown =
    groups.waiting.length === 0 && groups.on.length === 0 && groups.paused.length === 0;

  const row = (entry: AutomationEntry) => {
    const key = entryKey(entry);
    return (
      <AutomationSidebarRow
        key={key}
        entry={entry}
        current={activeKey === key}
        activeRunId={activeKey === key ? activeRunId : null}
        expanded={expanded.has(key)}
        onToggle={toggle}
        environmentLabel={environmentLabels?.get(entry.environmentId) ?? null}
      />
    );
  };

  return (
    <>
      <SidebarContent
        fixedHeader={
          <AutomationsPanelHeader prefs={prefs} query={query} onQueryChange={setQuery} />
        }
      >
        <div className="flex flex-col gap-2 px-2 pt-1 pb-2">
          {entries.length === 0 ? (
            loading ? (
              <div className="flex flex-col gap-2 px-2.5 pt-2" role="status">
                <span className="sr-only">Loading automations</span>
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-4/5" />
              </div>
            ) : (
              <EmptyAutomations />
            )
          ) : nothingShown ? (
            <p className="flex h-8 items-center px-2.5 text-sm text-sidebar-muted-foreground/60">
              {query?.trim() ? "No matches" : "Nothing needs you"}
            </p>
          ) : null}
          {groups.waiting.length > 0 ? (
            <section aria-label="Needs you">
              <RailSectionHeader accent>Needs you</RailSectionHeader>
              <WaitingAutomationList entries={groups.waiting} />
            </section>
          ) : null}
          {groups.on.length > 0 ? (
            <section aria-label="On">
              {groups.waiting.length > 0 || groups.paused.length > 0 ? (
                <RailSectionHeader>On</RailSectionHeader>
              ) : null}
              <SidebarMenu>{groups.on.map(row)}</SidebarMenu>
            </section>
          ) : null}
          {groups.paused.length > 0 ? (
            <section aria-label="Paused">
              <RailSectionHeader>Paused</RailSectionHeader>
              <SidebarMenu>{groups.paused.map(row)}</SidebarMenu>
            </section>
          ) : null}
        </div>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
