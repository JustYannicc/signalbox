/**
 * Automations: the rail's workflow panel. Active automations, each expandable
 * to the runs it produced (a run opens its chat), then paused ones, then the
 * built-in system automations. Focus hides the other side's automations the
 * way it hides sections in Home; system ones always stay in sight.
 * Reads placeholder fixtures until automations exist; nothing here writes.
 */
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type { Automation } from "../automations/automationModel";
import { automationDisplayStatus } from "../automations/automationStatus";
import {
  AutomationSidebarItem,
  AutomationsFilterMenu,
  SectionHeader,
  sortActive,
  type SortOrder,
} from "../automations/AutomationsSidebarList";
import { useAutomations } from "../automations/runDecisions";
import { THREAD_STATUS_DISPLAY } from "../threadStatusDisplay";
import {
  SidebarContent,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { focusModeInfo, useFocusMode } from "./focus/focusStore";
import { SidebarChromeFooter } from "./SidebarChrome";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

function needsYou(automation: Automation) {
  const status = automationDisplayStatus(automation);
  return status !== null && THREAD_STATUS_DISPLAY[status].needsYou;
}

export function AutomationsSidebar() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const focusMode = useFocusMode();
  const automations = useAutomations();
  const activeAutomationId = useParams({
    strict: false,
    select: (params) => params.automationId ?? null,
  });
  const activeRunId = useSearch({ strict: false, select: (search) => search.run ?? null });

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>("attention");
  const [onlyNeedsYou, setOnlyNeedsYou] = useState(false);
  const [peekHidden, setPeekHidden] = useState(false);
  // An automation opened on one of its runs starts expanded so the run is visible.
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set(activeAutomationId && activeRunId ? [activeAutomationId] : []),
  );

  const toggleExpanded = useCallback((automationId: string) => {
    setExpandedIds((ids) => {
      const next = new Set(ids);
      if (!next.delete(automationId)) next.add(automationId);
      return next;
    });
  }, []);

  const openAutomation = useCallback(
    (automationId: string, runId: string | null) => {
      if (isMobile) setOpenMobile(false);
      void navigate({
        to: "/automations/$automationId",
        params: { automationId },
        search: runId ? { run: runId } : {},
      });
    },
    [isMobile, navigate, setOpenMobile],
  );

  const { active, paused, system, hiddenByFocus } = useMemo(() => {
    const hiddenSections: readonly string[] = focusModeInfo(focusMode).hiddenRootSectionIds;
    const outOfFocus = (automation: Automation) =>
      automation.section !== undefined && hiddenSections.includes(automation.section);
    const query = searchQuery.trim().toLowerCase();
    const matches = automations.filter(
      (automation) =>
        (!query ||
          automation.name.toLowerCase().includes(query) ||
          automation.cadence.toLowerCase().includes(query)) &&
        (!onlyNeedsYou || needsYou(automation)),
    );
    const inSight = matches.filter(
      (automation) => peekHidden || automation.id === activeAutomationId || !outOfFocus(automation),
    );
    const custom = inSight.filter((automation) => !automation.system);
    return {
      active: sortActive(
        custom.filter((automation) => automation.enabled),
        sortOrder,
      ),
      paused: custom.filter((automation) => !automation.enabled),
      system: inSight.filter((automation) => automation.system),
      hiddenByFocus: matches.filter(outOfFocus).length,
    };
  }, [
    activeAutomationId,
    automations,
    focusMode,
    onlyNeedsYou,
    peekHidden,
    searchQuery,
    sortOrder,
  ]);

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
  };

  const renderItem = (automation: Automation) => (
    <AutomationSidebarItem
      key={automation.id}
      automation={automation}
      activeAutomationId={activeAutomationId}
      activeRunId={activeRunId}
      expanded={expandedIds.has(automation.id)}
      onToggle={toggleExpanded}
      onOpen={openAutomation}
    />
  );

  return (
    <>
      <SidebarContent
        fixedHeader={
          <div className="flex flex-col gap-2 p-2 pb-1">
            <div className="flex h-8 items-center gap-1 pl-2.5">
              {searchOpen ? (
                <>
                  <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
                  <SidebarInput
                    nativeInput
                    autoFocus
                    type="search"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        closeSearch();
                      }
                    }}
                    placeholder="Search automations"
                    aria-label="Search automations"
                    className="min-w-0 flex-1"
                  />
                  <SidebarHeaderIconButton label="Close search" onClick={closeSearch}>
                    <XIcon />
                  </SidebarHeaderIconButton>
                </>
              ) : (
                <>
                  <h2 className="min-w-0 flex-1 truncate text-base font-semibold tracking-tight text-sidebar-foreground">
                    Automations
                  </h2>
                  <AutomationsFilterMenu
                    sortOrder={sortOrder}
                    onSortOrderChange={setSortOrder}
                    onlyNeedsYou={onlyNeedsYou}
                    onOnlyNeedsYouChange={setOnlyNeedsYou}
                  />
                  <SidebarHeaderIconButton
                    label="Search automations"
                    onClick={() => setSearchOpen(true)}
                  >
                    <SearchIcon />
                  </SidebarHeaderIconButton>
                </>
              )}
            </div>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() =>
                    void navigate({ to: "/assistant", search: { prompt: "New automation: " } })
                  }
                >
                  <PlusIcon />
                  <span className="min-w-0 flex-1 truncate text-sidebar-foreground">
                    New automation
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </div>
        }
      >
        <div className="flex flex-col px-2 pb-2">
          <section aria-label="Active">
            <SectionHeader>Active</SectionHeader>
            {active.length === 0 ? (
              <p className="flex h-8 items-center px-2.5 text-sm text-sidebar-muted-foreground/50">
                {searchQuery.trim() || onlyNeedsYou ? "No matches" : "Nothing active"}
              </p>
            ) : (
              <ul className="flex flex-col gap-px">{active.map(renderItem)}</ul>
            )}
          </section>
          {paused.length > 0 ? (
            <section aria-label="Paused">
              <SectionHeader>Paused</SectionHeader>
              <ul className="flex flex-col gap-px">{paused.map(renderItem)}</ul>
            </section>
          ) : null}
          {system.length > 0 ? (
            <section aria-label="System">
              <SectionHeader>System</SectionHeader>
              <ul className="flex flex-col gap-px">{system.map(renderItem)}</ul>
            </section>
          ) : null}
          {hiddenByFocus > 0 ? (
            <button
              type="button"
              onClick={() => setPeekHidden((value) => !value)}
              className="mt-3 flex h-7 cursor-pointer items-center rounded-md px-2.5 text-left text-xs text-sidebar-muted-foreground/60 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            >
              {peekHidden
                ? "Hide out-of-focus automations"
                : `${hiddenByFocus} hidden by Focus · Show`}
            </button>
          ) : null}
        </div>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
