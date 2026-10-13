/**
 * Usage › Costs: spend rolled up the Home tree. The number at a level is
 * everything inside it; go into a folder to see what it's made of, and keep
 * going lower. Each level lists the folders inside it, then what sits right
 * there (threads, automations, its agent's own work) with the pool that paid.
 * Placeholder data (`levelCostFixtures.ts`); the rollup is `levelCosts.ts`.
 */
import { formatPercent, formatUsd } from "@t3tools/shared/usageFormat";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { isElectron } from "../../env";
import { PoolMark } from "../accounts/accountPoolsPrimitives";
import { UsageTabs } from "../accounts/UsageTabs";
import { LevelOptionsProvider, useLevelOptionsContext } from "../levels/LevelOptionsProvider";
import { TOP_LEVEL, type LevelKey } from "../levels/levels";
import type { LevelOption } from "../levels/levelOptions";
import { focusLabel } from "../sidebar/focus/focusLevels";
import { useFocusedLevel } from "../sidebar/focus/focusStore";
import { Badge } from "../ui/badge";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { LEVEL_COST_WINDOW_LABEL } from "./levelCostFixtures";
import { childLevels, costAt, levelPath, type CostEntry, type CostEntryKind } from "./levelCosts";
import { useLevelCosts, type LevelCosts } from "./useLevelCosts";

const KIND_LABEL: Record<CostEntryKind, string> = {
  thread: "Thread",
  automation: "Automation",
  agent: "Agent",
};

export function LevelCostsPage(props: { level: LevelKey | undefined }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex w-full min-w-0 items-center gap-3 py-2">
            <WorkspaceBreadcrumb ariaLabel="Usage breadcrumb" className="min-w-0 flex-1">
              <WorkspaceBreadcrumbItem current>
                <UsageTabs current="costs" />
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <Badge variant="outline" size="sm">
              Placeholder data
            </Badge>
          </div>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded" className="gap-8">
            <LevelOptionsProvider>
              <LevelCostsBody level={props.level ?? TOP_LEVEL} />
            </LevelOptionsProvider>
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function LevelCostsBody(props: { level: LevelKey }) {
  const options = useLevelOptionsContext();
  const rollup = useLevelCosts();
  const focusedLevel = useFocusedLevel();
  const byKey = new Map(options.map((option) => [option.key, option] as const));
  // A level that's gone or out of sight falls back to the top.
  const level = byKey.has(props.level) && rollup.inSight(props.level) ? props.level : TOP_LEVEL;
  const name = (key: LevelKey) => byKey.get(key)?.name ?? key;
  const cost = costAt(rollup.costs, level);
  const inside = childLevels(level, options, rollup.chainOf).filter((option) =>
    rollup.inSight(option.key),
  );
  const spending = inside.filter((option) => costAt(rollup.costs, option.key).totalUsd > 0);
  const idle = inside.filter((option) => costAt(rollup.costs, option.key).totalUsd === 0);
  const here = rollup.entries
    .filter((entry) => entry.level === level)
    .toSorted((a, b) => b.usd - a.usd);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <nav aria-label="Level path" className="flex flex-wrap items-center gap-1 text-sm">
          {levelPath(level, rollup.chainOf).map((key, index, path) => (
            <span key={key} className="flex items-center gap-1">
              {index > 0 ? (
                <ChevronRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
              ) : null}
              {index === path.length - 1 ? (
                <span aria-current="page" className="font-medium text-foreground">
                  {name(key)}
                </span>
              ) : (
                <LevelLink level={key} className="text-muted-foreground">
                  {name(key)}
                </LevelLink>
              )}
            </span>
          ))}
        </nav>
        <div className="flex flex-col gap-1">
          <p className="text-3xl font-semibold tracking-tight tabular-nums text-foreground">
            {formatUsd(cost.totalUsd)}
          </p>
          <p className="text-sm text-muted-foreground">
            {level === TOP_LEVEL ? "Everything" : `${name(level)} and everything inside it`}
            {" · "}
            {LEVEL_COST_WINDOW_LABEL} · API-equivalent, like Tokens
          </p>
          {rollup.focused ? (
            <p className="text-xs text-muted-foreground">
              Focus is on {focusLabel(focusedLevel)}: folders out of sight aren't counted.
            </p>
          ) : null}
        </div>
      </div>

      {inside.length > 0 ? (
        <CostSection title="Inside">
          {spending.map((option) => (
            <ChildRow key={option.key} option={option} rollup={rollup} parentUsd={cost.totalUsd} />
          ))}
          {idle.length > 0 ? (
            <p className="px-3 py-2.5 text-xs text-muted-foreground">
              No spend: {idle.map((option) => option.name).join(", ")}
            </p>
          ) : null}
        </CostSection>
      ) : null}

      <CostSection title={level === TOP_LEVEL ? "At the top level" : `Right in ${name(level)}`}>
        {here.length === 0 ? (
          <p className="px-3 py-2.5 text-sm text-muted-foreground">Nothing spent right here.</p>
        ) : (
          here.map((entry) => <EntryRow key={entry.id} entry={entry} />)
        )}
      </CostSection>

      {cost.byPool.size > 0 ? (
        <CostSection title="Paid by (nearest pool wins)">
          {[...cost.byPool]
            .toSorted((a, b) => b[1] - a[1])
            .map(([pool, usd]) => (
              <div key={pool ?? "none"} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {pool ?? "No pool on its path"}
                </span>
                <span className="text-sm tabular-nums text-foreground">{formatUsd(usd)}</span>
              </div>
            ))}
        </CostSection>
      ) : null}
    </div>
  );
}

function CostSection(props: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-foreground">{props.title}</h2>
      <div className="divide-y divide-border rounded-lg border border-border">{props.children}</div>
    </section>
  );
}

function LevelLink(props: { level: LevelKey; className?: string; children: ReactNode }) {
  return (
    <Link
      to="/costs"
      search={props.level === TOP_LEVEL ? {} : { level: props.level }}
      className={`hover:underline ${props.className ?? ""}`}
    >
      {props.children}
    </Link>
  );
}

/** A folder inside the current level: its total and its share of the current level's. */
function ChildRow(props: { option: LevelOption; rollup: LevelCosts; parentUsd: number }) {
  const { option } = props;
  const total = costAt(props.rollup.costs, option.key).totalUsd;
  const share = props.parentUsd > 0 ? total / props.parentUsd : 0;
  return (
    <Link
      to="/costs"
      search={{ level: option.key }}
      className="flex items-center gap-3 px-3 py-2.5 outline-none hover:bg-accent/50 focus-visible:bg-accent/50"
      aria-label={`${option.name}: ${formatUsd(total)}`}
    >
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{option.name}</span>
      <span
        aria-hidden
        className="hidden h-1.5 w-32 overflow-hidden rounded-full bg-muted sm:block"
      >
        <span
          className="block h-full rounded-full bg-primary/60"
          style={{ width: `${share * 100}%` }}
        />
      </span>
      <span className="hidden w-12 text-right text-xs tabular-nums text-muted-foreground sm:block">
        {formatPercent(share, 0)}
      </span>
      <span className="w-20 text-right text-sm tabular-nums text-foreground">
        {formatUsd(total)}
      </span>
      <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />
    </Link>
  );
}

function EntryRow(props: { entry: CostEntry }) {
  const { entry } = props;
  const label =
    entry.kind === "automation" ? (
      <Link
        to="/home/automations/$automationId"
        params={{ automationId: entry.id }}
        className="truncate text-sm text-foreground hover:underline"
      >
        {entry.label}
      </Link>
    ) : (
      <span className="truncate text-sm text-foreground">{entry.label}</span>
    );
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <PoolMark harness={entry.harness} className="size-3.5" />
      <div className="flex min-w-0 flex-1 flex-col">
        {label}
        <span className="truncate text-xs text-muted-foreground">
          {KIND_LABEL[entry.kind]} ·{" "}
          {entry.paidBy ? `Paid by ${entry.paidBy}` : "No pool on its path"}
        </span>
      </div>
      <span className="text-sm tabular-nums text-foreground">{formatUsd(entry.usd)}</span>
    </div>
  );
}
