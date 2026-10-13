/**
 * One level: the agent that represents it, what sits here by type, what it
 * inherits from levels above (things set to reach below, listed apart from
 * what sits here), which model pool it routes through, what it and everything
 * inside it spent (Usage › Costs), who may change what,
 * and (for team and project levels) what newcomers get. Open by default; you
 * only see actions you can take, and restricted areas carry a single
 * "Managed by … admins" note.
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowUpRightIcon, PlusIcon, ShieldIcon } from "lucide-react";

import { USABLE_POOLS } from "../accounts/accountPoolsFixtures";
import { PoolRouteList } from "../accounts/PoolRoutes";
import { agentAccess, inheritedAt, placedAt } from "../levels/levelAccess";
import { useLevelAgentName, useLevelLabel } from "../levels/LevelOptionsProvider";
import { THING_KIND_LABEL, toggleThingLevel, type LeveledThing } from "../levels/leveledThings";
import type { LevelOption } from "../levels/levelOptions";
import { SettingsSection } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { LevelCostLine } from "../usage/LevelCostLine";
import { LevelNewcomers, presetsAt } from "./LevelNewcomers";
import { LevelBadges, ManagedNote } from "./levelPrimitives";
import { LEVEL_POLICIES } from "./levelPolicyFixtures";
import {
  canChangeThing,
  isRestricted,
  PERMISSION_AREA_LABEL,
  PERMISSION_AREAS,
  policyFor,
  yourRole,
  type LevelPolicy,
} from "./levelPolicyModel";
import { comingSoon, HarnessGlyph, IntegrationMark } from "./pluginsPrimitives";

export type LevelTab = "here" | "newcomers";

// Automations and places are mapped from the Home tree, not here. Model
// accounts show as the pool this level routes through instead.
const KIND_ORDER = ["connections", "apis", "skills", "plugins"] as const;

function ThingMark(props: { thing: LeveledThing }) {
  const { thing } = props;
  if (thing.glyph) return <IntegrationMark glyph={thing.glyph} size="sm" />;
  if (thing.harness) {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center">
        <HarnessGlyph harness={thing.harness} />
      </span>
    );
  }
  return <span aria-hidden className="size-5 shrink-0" />;
}

function ThingRow(props: {
  thing: LeveledThing;
  policy: LevelPolicy | undefined;
  onRemove: () => void;
}) {
  const { thing } = props;
  return (
    <div className="flex items-center gap-3 px-3 py-2 sm:px-4">
      <ThingMark thing={thing} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-foreground">{thing.name}</span>
        <span className="truncate text-xs text-muted-foreground">{thing.detail}</span>
      </div>
      {thing.levels.length > 1 || thing.reach === "below" ? (
        <LevelBadges levels={thing.levels} reach={thing.reach} />
      ) : null}
      {canChangeThing(props.policy, thing) ? (
        <Button size="xs" variant="ghost-destructive" onClick={props.onRemove}>
          Remove
        </Button>
      ) : null}
    </div>
  );
}

/** Something reaching below from a level above; changed where it sits, not here. */
function InheritedRow(props: { thing: LeveledThing; from: string }) {
  const label = useLevelLabel();
  return (
    <div className="flex items-center gap-3 px-3 py-2 sm:px-4">
      <ThingMark thing={props.thing} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-foreground">{props.thing.name}</span>
        <span className="truncate text-xs text-muted-foreground">{props.thing.detail}</span>
      </div>
      <Badge
        variant="outline"
        size="sm"
        render={<Link to="/plugins" search={{ section: "levels", group: props.from }} />}
      >
        From {label(props.from)}
      </Badge>
    </div>
  );
}

function AddMenu(props: { level: LevelOption; policy: LevelPolicy | undefined }) {
  const add = (what: string) => comingSoon(`Add ${what} to ${props.level.label}`);
  const open = (area: "connections" | "apis" | "plugins") => !isRestricted(props.policy, area);
  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="outline" />}>
        <PlusIcon aria-hidden />
        Add
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => add("your own account")}>Your own account</MenuItem>
        <MenuItem onClick={() => add("one of your skills")}>One of your skills</MenuItem>
        {open("connections") ? (
          <MenuItem onClick={() => add("a shared connection")}>Shared connection</MenuItem>
        ) : null}
        {open("apis") ? <MenuItem onClick={() => add("an API")}>API</MenuItem> : null}
        {open("plugins") ? (
          <MenuItem onClick={() => add("a plugin")}>Codex or Claude plugin</MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function PermissionsList(props: { policy: LevelPolicy }) {
  return (
    <SettingsSection title="Who can change what">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 px-3 py-3 text-sm sm:px-4">
        {PERMISSION_AREAS.map((area) => {
          const restricted = isRestricted(props.policy, area);
          return (
            <div key={area} className="contents">
              <span className="text-foreground">{PERMISSION_AREA_LABEL[area]}</span>
              <span className="flex items-center justify-end gap-1.5 text-muted-foreground">
                {restricted ? <ShieldIcon aria-hidden className="size-3" /> : null}
                {restricted ? "Admins" : "Members"}
              </span>
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
}

function HereTab(props: {
  level: LevelOption;
  policy: LevelPolicy | undefined;
  things: readonly LeveledThing[];
}) {
  const { level, policy } = props;
  const here = placedAt(props.things, level.key);
  // Pools resolve nearest-first below, so only list what else comes from above.
  const inherited = inheritedAt(
    props.things.filter((thing) => thing.kind !== "models"),
    level.key,
  );
  const remove = (thing: LeveledThing) => {
    toggleThingLevel(thing.key, thing.levels, level.key, false);
    toastManager.add({
      title: `Removed ${thing.name} from ${level.label}`,
      description: "Agents lose it on their next turn unless another level still gives it.",
      timeout: 3000,
    });
  };

  return (
    <div className="flex flex-col gap-8">
      {policy ? <PermissionsList policy={policy} /> : null}
      {KIND_ORDER.map((kind) => {
        const ofKind = here.filter((thing) => thing.kind === kind);
        return (
          <SettingsSection
            key={kind}
            title={`${THING_KIND_LABEL[kind]} (${ofKind.length})`}
            headerAction={
              policy && isRestricted(policy, kind) ? <ManagedNote policy={policy} /> : undefined
            }
          >
            {ofKind.length === 0 ? (
              <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">Nothing here.</p>
            ) : (
              ofKind.map((thing) => (
                <ThingRow
                  key={thing.key}
                  thing={thing}
                  policy={policy}
                  onRemove={() => remove(thing)}
                />
              ))
            )}
          </SettingsSection>
        );
      })}
      {inherited.length > 0 ? (
        <SettingsSection title={`Inherited from above (${inherited.length})`}>
          {inherited.map(({ thing, from }) => (
            <InheritedRow key={thing.key} thing={thing} from={from} />
          ))}
        </SettingsSection>
      ) : null}
      <SettingsSection
        title="Model pools"
        headerAction={
          <Button size="xs" variant="ghost" render={<Link to="/accounts" />}>
            Manage in Usage › Accounts
            <ArrowUpRightIcon aria-hidden />
          </Button>
        }
      >
        <PoolRouteList level={level.key} pools={USABLE_POOLS} />
      </SettingsSection>
    </div>
  );
}

export function LevelDetail(props: {
  level: LevelOption;
  things: readonly LeveledThing[];
  tab: LevelTab;
  item: string | undefined;
}) {
  const { level } = props;
  const navigate = useNavigate();
  const agentName = useLevelAgentName();
  const policy = policyFor(level.key, LEVEL_POLICIES);
  const presets = presetsAt(level.key);
  const preset = presets.find((entry) => entry.id === props.item) ?? presets[0];
  const tab = preset ? props.tab : "here";
  const access = agentAccess(level.key, props.things);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3 px-3 sm:px-4">
        <Button
          size="xs"
          variant="ghost-muted"
          className="self-start"
          render={<Link to="/plugins" search={{ section: "levels" }} />}
        >
          <ArrowLeftIcon aria-hidden />
          All levels
        </Button>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">{level.label}</h2>
            <p className="text-sm text-muted-foreground">
              Represented by <span className="text-foreground">{agentName(level.key)}</span>
              {" · "}
              Your role: <span className="text-foreground">{yourRole(policy)}</span>
            </p>
            <p className="text-sm text-muted-foreground">
              Can use {access.usable.length} {access.usable.length === 1 ? "thing" : "things"}
              {access.asks.length > 0
                ? `; has to ask ${access.asks.map((ask) => agentName(ask.level)).join(" or ")} for the rest.`
                : "."}
            </p>
            <LevelCostLine level={level.key} />
          </div>
          {tab === "here" ? <AddMenu level={level} policy={policy} /> : null}
        </div>
        {preset ? (
          <ToggleGroup
            aria-label="Level view"
            value={[tab]}
            onValueChange={(next) => {
              const nextTab = next[0] === "newcomers" ? "newcomers" : "here";
              void navigate({
                to: "/plugins",
                search: {
                  section: "levels",
                  group: level.key,
                  ...(nextTab === "newcomers" ? { tab: nextTab } : {}),
                },
              });
            }}
            className="self-start"
          >
            <Toggle value="here">What sits here</Toggle>
            <Toggle value="newcomers">What newcomers get</Toggle>
          </ToggleGroup>
        ) : null}
      </div>

      {tab === "newcomers" && preset ? (
        <LevelNewcomers preset={preset} policy={policy} />
      ) : (
        <HereTab level={level} policy={policy} things={props.things} />
      )}
    </div>
  );
}
