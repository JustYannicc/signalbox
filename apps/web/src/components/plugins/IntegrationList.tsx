/**
 * Connections: every MCP server and API in one list, filtered by kind and
 * group. Integrations with several accounts list them underneath; a row
 * expands in place for tools, harnesses, and account actions.
 */
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { SettingsSection } from "../settings/settingsLayout";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { AccountRow, useAccountNames } from "./ConnectionAccounts";
import { GroupBadges } from "./groupPrimitives";
import { GROUPS } from "./groupsFixtures";
import { IntegrationDetail } from "./IntegrationDetail";
import {
  harnessRestriction,
  integrationGroups,
  KIND_LABEL,
  matchesKind,
  type ConnectionAccount,
  type ConnectionKindFilter,
  type GroupId,
  type HarnessId,
  type Integration,
} from "./pluginsModel";
import { INTEGRATIONS } from "./pluginsFixtures";
import { useAddedConnections } from "./addedConnectionsStore";
import {
  AuthStateBadge,
  DEEP_LINK_ROW_CLASS,
  IntegrationMark,
  useDeepLinkRow,
  useHarnessSelection,
} from "./pluginsPrimitives";

type GroupFilter = GroupId | "all";

const KIND_FILTERS: readonly { value: ConnectionKindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "mcp", label: "MCP" },
  { value: "api", label: "API" },
];

/** An integration with only the accounts the group filter lets through. */
interface ScopedIntegration {
  readonly integration: Integration;
  readonly accounts: readonly ConnectionAccount[];
}

function scopeToGroup(integrations: readonly Integration[], filter: GroupFilter) {
  return integrations.flatMap((integration): ScopedIntegration[] => {
    if (filter === "all") return [{ integration, accounts: integration.accounts }];
    if (integration.accounts.length === 0) {
      return integrationGroups(integration).includes(filter) ? [{ integration, accounts: [] }] : [];
    }
    const accounts = integration.accounts.filter((account) => account.groups.includes(filter));
    return accounts.length > 0 ? [{ integration, accounts }] : [];
  });
}

interface RowState {
  readonly expandedId: string | null;
  readonly targetId: string | undefined;
  readonly onToggleExpanded: (id: string) => void;
  readonly selection: Record<string, readonly HarnessId[]>;
  readonly onToggleHarness: (
    id: string,
    harness: HarnessId,
    fallback: readonly HarnessId[],
  ) => void;
  readonly names: Record<string, string>;
  readonly onRename: (accountId: string, name: string) => void;
}

function IntegrationRow(props: { scoped: ScopedIntegration; state: RowState }) {
  const { integration, accounts } = props.scoped;
  const { state } = props;
  const expanded = state.expandedId === integration.id;
  const targeted = state.targetId === integration.id;
  const rowRef = useDeepLinkRow<HTMLDivElement>(targeted);
  const enabled = state.selection[integration.id] ?? integration.harnesses;
  const single = accounts.length === 1 ? accounts[0] : undefined;
  const restriction = harnessRestriction(enabled);
  const subtitle = [
    KIND_LABEL[integration.kind],
    single ? `${state.names[single.id] ?? single.label} · ${single.identity}` : null,
    accounts.length > 1 ? `${accounts.length} accounts` : null,
    restriction,
  ]
    .filter(Boolean)
    .join(" · ");
  const groups = [...new Set(accounts.flatMap((account) => account.groups))];

  return (
    <div ref={rowRef} className={cn(targeted && DEEP_LINK_ROW_CLASS)}>
      <div className="flex items-center gap-3 px-3 py-2 sm:px-4">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => state.onToggleExpanded(integration.id)}
          className="-mx-1 flex min-w-0 flex-1 items-center gap-3 rounded-md px-1 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
              expanded && "rotate-90",
            )}
          />
          <IntegrationMark glyph={integration.glyph} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium text-foreground">{integration.name}</span>
            <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
          </span>
          <span className="hidden shrink-0 sm:flex">
            <GroupBadges groups={accounts.length > 0 ? groups : integrationGroups(integration)} />
          </span>
          <AuthStateBadge auth={integration.auth} />
          <span className="hidden w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:block">
            {integration.toolCount} tools
          </span>
        </button>
      </div>
      {accounts.length > 1 ? (
        <div className="flex flex-col pb-1.5">
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              integration={integration}
              account={account}
              name={state.names[account.id] ?? account.label}
              onRename={(name) => state.onRename(account.id, name)}
            />
          ))}
        </div>
      ) : null}
      {expanded ? (
        <IntegrationDetail
          integration={integration}
          single={single}
          singleName={single ? (state.names[single.id] ?? single.label) : undefined}
          onRename={(name) => (single ? state.onRename(single.id, name) : undefined)}
          enabled={enabled}
          onToggleHarness={(harness) =>
            state.onToggleHarness(integration.id, harness, integration.harnesses)
          }
        />
      ) : null}
    </div>
  );
}

function IntegrationGroup(props: {
  title: string;
  items: readonly ScopedIntegration[];
  state: RowState;
}) {
  if (props.items.length === 0) return null;
  return (
    <SettingsSection title={props.title}>
      {props.items.map((scoped) => (
        <IntegrationRow key={scoped.integration.id} scoped={scoped} state={props.state} />
      ))}
    </SettingsSection>
  );
}

export function IntegrationList(props: { item?: string | undefined }) {
  const [expandedId, setExpandedId] = useState<string | null>(props.item ?? null);
  const [kind, setKind] = useState<ConnectionKindFilter>("all");
  const [groupFilter, setGroupFilter] = useState<GroupFilter>("all");
  const [selection, toggleHarness] = useHarnessSelection(INTEGRATIONS);
  const [names, rename] = useAccountNames(INTEGRATIONS);

  const state: RowState = {
    expandedId,
    targetId: props.item,
    onToggleExpanded: (id) => setExpandedId((current) => (current === id ? null : id)),
    selection,
    onToggleHarness: toggleHarness,
    names,
    onRename: rename,
  };
  const added = useAddedConnections((store) => store.integrations);
  const matching = [...INTEGRATIONS, ...added].filter((item) => matchesKind(item, kind));
  const brokered = scopeToGroup(
    matching.filter((item) => item.via === "executor"),
    groupFilter,
  );
  const direct = scopeToGroup(
    matching.filter((item) => item.via === "direct"),
    groupFilter,
  );

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3 px-3 sm:px-4">
        <p className="text-sm text-muted-foreground">
          Executor keeps the credentials; each account's name is what models see.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            aria-label="Filter by kind"
            value={[kind]}
            onValueChange={(next) => {
              const value = KIND_FILTERS.find((entry) => entry.value === next[0]);
              if (value) setKind(value.value);
            }}
          >
            {KIND_FILTERS.map((entry) => (
              <Toggle key={entry.value} value={entry.value}>
                {entry.label}
              </Toggle>
            ))}
          </ToggleGroup>
          <ToggleGroup
            aria-label="Filter by group"
            value={[groupFilter]}
            onValueChange={(next) => {
              const value = next[0];
              if (value) setGroupFilter(value);
            }}
            className="sm:ms-auto"
          >
            <Toggle value="all">All groups</Toggle>
            {GROUPS.map((group) => (
              <Toggle key={group.id} value={group.id}>
                {group.name}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
      </div>
      {brokered.length + direct.length === 0 ? (
        <p className="px-3 text-sm text-muted-foreground sm:px-4">Nothing matches these filters.</p>
      ) : null}
      <IntegrationGroup title="Via Executor" items={brokered} state={state} />
      <IntegrationGroup title="Direct (not via Executor)" items={direct} state={state} />
    </div>
  );
}
