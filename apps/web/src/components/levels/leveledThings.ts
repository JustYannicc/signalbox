/**
 * What sits at each Home level besides threads: connections (Executor
 * accounts and direct servers), APIs, model accounts, skills, and harness
 * plugins, flattened into one list. Placements you change in Plugins live in
 * `useLevelPlacementStore` and override the fixtures everywhere: Plugins, the
 * agent page's Access view, and the Home tree (`skillLevels`).
 *
 * Each thing also has a reach: `here` (only its own level's agent, the
 * default) or `below` ("Available to folders inside"). Model accounts default
 * to `below`, and the nearest pool wins (see `accounts/poolRouting.ts`).
 *
 * Automations and places are mapped in `sidebar/sections/mappedItems.ts`; pass
 * them in as `LeveledThing`s (kind "automations" | "places") where needed.
 */
import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { prototypeStorage } from "../../lib/prototypeStorage";
import type { PoolAccount, PoolHarness } from "../accounts/accountPoolsModel";
import { POOL_ACCOUNTS } from "../accounts/accountPoolsFixtures";
import { POOL_LABEL } from "../accounts/accountPoolsModel";
import { useAddedConnections } from "../plugins/addedConnectionsStore";
import { HARNESS_PLUGINS, INTEGRATIONS, SKILLS } from "../plugins/pluginsFixtures";
import {
  isApiKind,
  type AddedBy,
  type ConnectionAccount,
  type HarnessId,
  type HarnessPlugin,
  type Integration,
  type Skill,
} from "../plugins/pluginsModel";
import type { LevelKey, Reach } from "./levels";

export { SKILLS };

export type ThingKind =
  | "connections"
  | "apis"
  | "models"
  | "skills"
  | "plugins"
  | "automations"
  | "places";

export const THING_KIND_LABEL: Record<ThingKind, string> = {
  connections: "Connections",
  apis: "APIs",
  models: "Model accounts",
  skills: "Skills",
  plugins: "Codex & Claude plugins",
  automations: "Automations",
  places: "Places",
};

/** Count nouns, so names keep their casing ("7 APIs", "2 Codex & Claude plugins"). */
const COUNT_NOUN: Record<ThingKind, readonly [one: string, many: string]> = {
  connections: ["connection", "connections"],
  apis: ["API", "APIs"],
  models: ["model account", "model accounts"],
  skills: ["skill", "skills"],
  plugins: ["Codex & Claude plugin", "Codex & Claude plugins"],
  automations: ["automation", "automations"],
  places: ["place", "places"],
};

export function countThings(count: number, kind: ThingKind) {
  const [one, many] = COUNT_NOUN[kind];
  return `${count} ${count === 1 ? one : many}`;
}

export interface LeveledThing {
  /** `account:<id>`, `integration:<id>`, `model:<id>`, `skill:<id>`, `plugin:<id>`. */
  readonly key: string;
  readonly kind: ThingKind;
  readonly name: string;
  readonly detail: string;
  readonly glyph?: string;
  readonly harness?: HarnessId;
  readonly levels: readonly LevelKey[];
  /** Whether folders inside its levels may use it too. Absent means `here`. */
  readonly reach?: Reach;
  /** Admins own org-provided things; you can always move or remove your own. Defaults to you. */
  readonly addedBy?: AddedBy;
}

export interface LeveledSources {
  readonly integrations: readonly Integration[];
  readonly models: readonly PoolAccount[];
  readonly skills: readonly Skill[];
  readonly plugins: readonly HarnessPlugin[];
}

type Overrides = Readonly<Record<string, readonly LevelKey[]>>;
type ReachOverrides = Readonly<Record<string, Reach>>;

/** Model pools reach every folder inside their level; everything else stays where it sits. */
export function defaultReach(kind: ThingKind): Reach {
  return kind === "models" ? "below" : "here";
}

interface LevelPlacementState {
  /** Levels you changed, by thing key; absent means the fixture default. */
  levels: Record<string, readonly LevelKey[]>;
  /** Reach you changed, by thing key; absent means `defaultReach` for its kind. */
  reach: Record<string, Reach>;
  setLevels: (key: string, levels: readonly LevelKey[]) => void;
  setReach: (key: string, reach: Reach) => void;
}

export const useLevelPlacementStore = create<LevelPlacementState>()(
  persist(
    (set) => ({
      levels: {},
      reach: {},
      setLevels: (key, levels) => set((state) => ({ levels: { ...state.levels, [key]: levels } })),
      setReach: (key, reach) => set((state) => ({ reach: { ...state.reach, [key]: reach } })),
    }),
    { name: "t3code:levels:placement:v1", version: 1, storage: prototypeStorage() },
  ),
);

/** A thing's current levels: your change, else the fixture's. */
export function useThingLevels(key: string, fallback: readonly LevelKey[]): readonly LevelKey[] {
  return useLevelPlacementStore((state) => state.levels[key]) ?? fallback;
}

/** A thing's current reach: your change, else the default for its kind. */
export function useThingReach(key: string, fallback: Reach = "here"): Reach {
  return useLevelPlacementStore((state) => state.reach[key]) ?? fallback;
}

export function setThingReach(key: string, reach: Reach) {
  useLevelPlacementStore.getState().setReach(key, reach);
}

/** Adds or removes one level, keeping the rest. */
export function toggleThingLevel(
  key: string,
  current: readonly LevelKey[],
  level: LevelKey,
  checked: boolean,
) {
  const next = checked
    ? [...current.filter((entry) => entry !== level), level]
    : current.filter((entry) => entry !== level);
  useLevelPlacementStore.getState().setLevels(key, next);
}

const POOL_HARNESS: Record<PoolHarness, HarnessId> = {
  codex: "codex",
  claude: "claudeAgent",
  grok: "grok",
};

function accountThing(
  integration: Integration,
  account: ConnectionAccount,
  overrides: Overrides,
): LeveledThing {
  const key = `account:${account.id}`;
  return {
    key,
    kind: isApiKind(integration.kind) ? "apis" : "connections",
    name: `${integration.name} · ${account.label}`,
    detail: account.identity,
    glyph: integration.glyph,
    levels: overrides[key] ?? account.levels,
    addedBy: account.addedBy,
    ...(account.reach ? { reach: account.reach } : {}),
  };
}

/** Every leveled thing in display order, with your placement and reach changes applied. */
export function leveledThings(
  sources: LeveledSources,
  overrides: Overrides,
  reachOverrides: ReachOverrides = {},
): LeveledThing[] {
  const connections = sources.integrations.flatMap((integration) =>
    integration.accounts.length > 0
      ? integration.accounts.map((account) => accountThing(integration, account, overrides))
      : [
          {
            key: `integration:${integration.id}`,
            kind: "connections" as const,
            name: integration.name,
            detail: `Direct MCP · ${integration.transport ?? "stdio"}`,
            glyph: integration.glyph,
            levels: overrides[`integration:${integration.id}`] ?? integration.levels ?? [],
            addedBy: "you" as const,
            ...(integration.reach ? { reach: integration.reach } : {}),
          },
        ],
  );
  // Pool accounts live in Usage › Accounts, which owns their levels.
  const models = sources.models.map((account): LeveledThing => ({
    key: `model:${account.id}`,
    kind: "models",
    name: `${POOL_LABEL[account.harness]} · ${account.plan}`,
    detail: account.name,
    harness: POOL_HARNESS[account.harness],
    levels: account.levels,
    addedBy: "admins",
  }));
  const skills = sources.skills.map((skill): LeveledThing => ({
    key: `skill:${skill.id}`,
    kind: "skills",
    name: skill.name,
    detail: skill.description,
    levels: overrides[`skill:${skill.id}`] ?? skill.levels,
    // Members publish skills themselves, so the ones you wrote are yours to pull back.
    addedBy:
      skill.source === "personal" || (skill.source === "team" && skill.origin === "you")
        ? "you"
        : "admins",
    ...(skill.reach ? { reach: skill.reach } : {}),
  }));
  const plugins = sources.plugins.map((plugin): LeveledThing => ({
    key: `plugin:${plugin.id}`,
    kind: "plugins",
    name: plugin.name,
    detail: plugin.description,
    harness: plugin.harness,
    levels: overrides[`plugin:${plugin.id}`] ?? plugin.levels,
    addedBy: "admins",
  }));
  return [...connections, ...models, ...skills, ...plugins].map((thing) => ({
    ...thing,
    // Your change, else the fixture's own reach, else the default for its kind.
    reach: reachOverrides[thing.key] ?? thing.reach ?? defaultReach(thing.kind),
  }));
}

/** Every leveled thing, live: fixtures, connections added this session, and your changes. */
export function useLeveledThings(): readonly LeveledThing[] {
  const added = useAddedConnections((state) => state.integrations);
  const overrides = useLevelPlacementStore((state) => state.levels);
  const reach = useLevelPlacementStore((state) => state.reach);
  return useMemo(
    () =>
      leveledThings(
        {
          integrations: [...INTEGRATIONS, ...added],
          models: POOL_ACCOUNTS,
          skills: SKILLS,
          plugins: HARNESS_PLUGINS,
        },
        overrides,
        reach,
      ),
    [added, overrides, reach],
  );
}

function skillLevelMap(overrides: Overrides): ReadonlyMap<string, readonly LevelKey[]> {
  return new Map(
    SKILLS.map((skill) => [skill.id, overrides[`skill:${skill.id}`] ?? skill.levels] as const),
  );
}

/** Each skill's levels by skill id, for the Home tree strip. Not reactive; see `useSkillLevels`. */
export function skillLevels(): ReadonlyMap<string, readonly LevelKey[]> {
  return skillLevelMap(useLevelPlacementStore.getState().levels);
}

export function useSkillLevels(): ReadonlyMap<string, readonly LevelKey[]> {
  const overrides = useLevelPlacementStore((state) => state.levels);
  return useMemo(() => skillLevelMap(overrides), [overrides]);
}
