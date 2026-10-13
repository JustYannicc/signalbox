/**
 * The long-lived things a Home folder holds besides its threads: automations,
 * connected accounts (sitting at the level they are connected at, holding
 * whatever no place covers) and mapped places inside them (a Drive folder, a
 * Slack channel). Each lives in exactly one folder (its home) and moves with
 * "Move to…". Places and accounts can also be referenced from other folders:
 * the reference shows there and lets that folder's agent use the thing. And a
 * place or account can reach `below`, so every folder inside its home can use
 * it too. Each folder shows all of this as one collapsed strip; only what
 * needs you breaks out. Built-in automations and global guards are rules at
 * the top level; only built-ins can't move. Skills sit at the levels Plugins
 * places them (`leveledThings`), possibly several. A new kind adds a union
 * member, its default home and its order.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { prototypeStorage } from "../../../lib/prototypeStorage";
import type { Automation } from "../../automations/automationModel";
import { automationDisplayStatus } from "../../automations/automationStatus";
import {
  SPACES_MAPPINGS,
  T3CODE_PROJECT,
  mappingHealth,
  type HomeTarget,
  type SpacesMapping,
} from "../../spaces/spacesMappings";
import { SPACES_SOURCES, type SpacesSourceFixture } from "../../spaces/spacesFixtures";
import type { Reach } from "../../levels/levels";
import type { Skill } from "../../plugins/pluginsModel";
import { THREAD_STATUS_DISPLAY, type ThreadDisplayStatus } from "../../threadStatusDisplay";
import { ROOT_CONTAINER_KEY } from "./sectionStore";

export type MappedItem =
  | {
      readonly kind: "automation";
      readonly id: string;
      readonly title: string;
      readonly automation: Automation;
      readonly status: ThreadDisplayStatus | null;
    }
  | {
      readonly kind: "account";
      readonly id: string;
      readonly title: string;
      readonly source: SpacesSourceFixture;
      readonly status: ThreadDisplayStatus | null;
    }
  | {
      readonly kind: "place";
      readonly id: string;
      readonly title: string;
      readonly mapping: SpacesMapping;
      readonly status: ThreadDisplayStatus | null;
    }
  | {
      readonly kind: "skill";
      readonly id: string;
      readonly title: string;
      readonly skill: Skill;
      readonly status: null;
    };

export type MappedKind = MappedItem["kind"];

/** Strip order after needs-you: automations, accounts, the places inside them, skills. */
const KIND_ORDER: Readonly<Record<MappedKind, number>> = {
  automation: 0,
  account: 1,
  place: 2,
  skill: 3,
};

export const placeItemId = (mappingId: string) => `place:${mappingId}`;
export const accountItemId = (sourceId: string) => `account:${sourceId}`;
/** Same key Plugins uses for the skill's placement. */
export const skillItemId = (skillId: string) => `skill:${skillId}`;

/**
 * Every fixture automation's default home. Built-ins (`automation.system`) and
 * global guards are rules at the top level, applying to everything below.
 */
export const AUTOMATION_HOMES: Readonly<Record<string, HomeTarget>> = {
  "capture-routing": ROOT_CONTAINER_KEY,
  "danger-check": ROOT_CONTAINER_KEY,
  "no-force-push": ROOT_CONTAINER_KEY,
  "sync-upstream": T3CODE_PROJECT,
  "review-prs": T3CODE_PROJECT,
  "sentry-feedback-fix": T3CODE_PROJECT,
  "triage-sentry": T3CODE_PROJECT,
  "ship-change": T3CODE_PROJECT,
  "spec-to-pr": T3CODE_PROJECT,
  "integration-health": "section:personal",
  "work-out-of-sight": "section:personal",
  "water-plants": "section:personal",
  "reconcile-card-bill": "section:work",
  "monthly-expenses": "section:work",
  "notion-digest": "section:work",
  "customer-replies": "section:work-northwind",
};

export function needsYou(item: MappedItem): boolean {
  return item.status !== null && THREAD_STATUS_DISPLAY[item.status].needsYou;
}

export interface ProjectRef {
  readonly projectKey: string;
  readonly displayName: string;
  readonly workspaceRoot: string;
}

export function resolveTarget(target: HomeTarget, projects: readonly ProjectRef[]): string {
  if (typeof target === "string") return target;
  // Name or folder name only: a whole path would match every project inside the repo.
  const match = projects.find((project) => {
    const folder = project.workspaceRoot.split(/[\\/]/).findLast(Boolean) ?? "";
    const haystack = `${project.displayName} ${folder}`.toLowerCase();
    return target.projectNamed.some((name) => haystack.includes(name));
  });
  return match ? `project:${match.projectKey}` : target.fallback;
}

/** An automation's default home; one the table doesn't know (a new one) starts at the top. */
export function automationHomeTarget(automationId: string): HomeTarget {
  return AUTOMATION_HOMES[automationId] ?? ROOT_CONTAINER_KEY;
}

/** Your changes, by mapped id; an absent entry means the fixture default. */
export interface MappedOverrides {
  /** The folder it lives in; null unmaps a place (its items go back to its account). */
  readonly homes: Readonly<Record<string, string | null>>;
  /** Folders that reference a place or account. */
  readonly references: Readonly<Record<string, readonly string[]>>;
  readonly reach: Readonly<Record<string, Reach>>;
}

const NO_OVERRIDES: MappedOverrides = { homes: {}, references: {}, reach: {} };

type Placeable = Exclude<MappedItem, { kind: "skill" }>;

function defaultPlacement(item: Placeable): {
  home: HomeTarget;
  references: readonly HomeTarget[];
  reach: Reach;
} {
  switch (item.kind) {
    case "automation":
      return { home: automationHomeTarget(item.automation.id), references: [], reach: "here" };
    case "account":
      return { home: `section:${item.source.space}`, references: [], reach: "here" };
    case "place":
      return {
        home: item.mapping.home,
        references: item.mapping.references ?? [],
        reach: item.mapping.reach ?? "here",
      };
  }
}

/** Mapped places that still sit in a folder; an unmapped one's items fall back to its account. */
export function activeMappings(
  homeOverrides: MappedOverrides["homes"] = {},
): readonly SpacesMapping[] {
  return SPACES_MAPPINGS.filter((mapping) => homeOverrides[placeItemId(mapping.id)] !== null);
}

function allMappedItems(
  automations: readonly Automation[],
  skills: readonly Skill[],
): MappedItem[] {
  return [
    ...automations.map((automation) => ({
      kind: "automation" as const,
      id: `automation:${automation.id}`,
      title: automation.name,
      automation,
      status: automationDisplayStatus(automation),
    })),
    ...SPACES_SOURCES.map((source) => ({
      kind: "account" as const,
      id: accountItemId(source.id),
      title: source.name,
      source,
      status: source.sync === "error" ? ("failed" as const) : null,
    })),
    ...SPACES_MAPPINGS.map((mapping) => ({
      kind: "place" as const,
      id: placeItemId(mapping.id),
      title: mapping.name,
      mapping,
      status: mappingHealth(mapping).failed ? ("failed" as const) : null,
    })),
    ...skills.map((skill) => ({
      kind: "skill" as const,
      id: skillItemId(skill.id),
      title: skill.name,
      skill,
      status: null,
    })),
  ];
}

const priority = (item: MappedItem) =>
  needsYou(item) && item.status ? THREAD_STATUS_DISPLAY[item.status].priority : 0;

/** Needs-you first, then by kind (`KIND_ORDER`), then by name. */
function compareMapped(left: MappedItem, right: MappedItem): number {
  return (
    priority(right) - priority(left) ||
    KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
    left.title.localeCompare(right.title)
  );
}

export interface MappedIndex {
  readonly byContainer: ReadonlyMap<string, readonly MappedItem[]>;
  /** Every folder each mapped id shows in: its home, then its references (a skill's levels). */
  readonly homesById: ReadonlyMap<string, readonly string[]>;
  /** The one folder it lives in; null for an unmapped place. Skills have none (see `homesById`). */
  readonly homeById: ReadonlyMap<string, string | null>;
  /** Folders that reference a place or account; its agent can use it there. */
  readonly referencesById: ReadonlyMap<string, readonly string[]>;
  /** `below`: every folder inside its home can use it too. */
  readonly reachById: ReadonlyMap<string, Reach>;
}

export const EMPTY_MAPPED_INDEX: MappedIndex = {
  byContainer: new Map(),
  homesById: new Map(),
  homeById: new Map(),
  referencesById: new Map(),
  reachById: new Map(),
};

export function buildMappedIndex(input: {
  automations: readonly Automation[];
  projects: readonly ProjectRef[];
  overrides?: MappedOverrides;
  /** Skills and their levels (Plugins' placement, overrides applied). */
  skills?: {
    readonly list: readonly Skill[];
    readonly levels: ReadonlyMap<string, readonly string[]>;
  };
}): MappedIndex {
  const overrides = input.overrides ?? NO_OVERRIDES;
  const resolve = (target: HomeTarget) => resolveTarget(target, input.projects);
  const byContainer = new Map<string, MappedItem[]>();
  const homesById = new Map<string, readonly string[]>();
  const homeById = new Map<string, string | null>();
  const referencesById = new Map<string, readonly string[]>();
  const reachById = new Map<string, Reach>();
  const skills = input.skills;
  for (const item of allMappedItems(input.automations, skills?.list ?? [])) {
    let shownIn: readonly string[];
    if (item.kind === "skill") {
      shownIn = [...new Set(skills?.levels.get(item.skill.id) ?? [])];
    } else {
      const defaults = defaultPlacement(item);
      const homeOverride = overrides.homes[item.id];
      // Only a place can be unmapped; anything else always has a home.
      const home =
        homeOverride === null
          ? item.kind === "place"
            ? null
            : resolve(defaults.home)
          : (homeOverride ?? resolve(defaults.home));
      const references =
        home === null || item.kind === "automation"
          ? []
          : [
              ...new Set(
                (overrides.references[item.id] ?? defaults.references.map(resolve)).filter(
                  (key) => key !== home,
                ),
              ),
            ];
      homeById.set(item.id, home);
      referencesById.set(item.id, references);
      reachById.set(
        item.id,
        item.kind === "automation" ? "here" : (overrides.reach[item.id] ?? defaults.reach),
      );
      shownIn = home === null ? [] : [home, ...references];
    }
    homesById.set(item.id, shownIn);
    for (const key of shownIn) {
      const bucket = byContainer.get(key);
      if (bucket) bucket.push(item);
      else byContainer.set(key, [item]);
    }
  }
  for (const bucket of byContainer.values()) bucket.sort(compareMapped);
  return { byContainer, homesById, homeById, referencesById, reachById };
}

interface MappedState extends MappedOverrides {
  /** Containers whose strip is open. */
  readonly openStrips: Readonly<Record<string, true>>;
  setHome: (id: string, home: string | null) => void;
  setReferences: (id: string, references: readonly string[]) => void;
  setReach: (id: string, reach: Reach) => void;
  toggleStrip: (containerKey: string) => void;
}

type PersistedMapped = Pick<MappedState, "homes" | "references" | "reach" | "openStrips">;

/**
 * v1 keyed places `source:<id>`. v2 let a thing sit in many homes: the first
 * stays its home and the rest become references (places and accounts; an
 * automation just keeps its first). The old `system` folder is the top level now.
 */
export function migrateMapped(persisted: unknown, version: number): PersistedMapped {
  const state = (persisted ?? {}) as Partial<PersistedMapped>;
  if (version >= 3) {
    return { homes: {}, references: {}, reach: {}, openStrips: {}, ...state };
  }
  const legacy = (state.homes ?? {}) as unknown as Record<string, readonly string[]>;
  const homes: Record<string, string | null> = {};
  const references: Record<string, readonly string[]> = {};
  for (const [legacyId, keys] of Object.entries(legacy)) {
    const id = legacyId.startsWith("source:") ? placeItemId(legacyId.slice(7)) : legacyId;
    const [home, ...rest] = new Set(
      keys.map((key) => (key === "system" ? ROOT_CONTAINER_KEY : key)),
    );
    if (id.startsWith("automation:") || id.startsWith("account:")) {
      if (home === undefined) continue;
      homes[id] = home;
      if (id.startsWith("account:")) references[id] = rest;
    } else if (id.startsWith("place:")) {
      homes[id] = home ?? null;
      // The old list replaced the fixture's homes outright, so its references do too.
      references[id] = rest;
    }
  }
  return { homes, references, reach: {}, openStrips: state.openStrips ?? {} };
}

export const useMappedStore = create<MappedState>()(
  persist(
    (set) => ({
      homes: {},
      references: {},
      reach: {},
      openStrips: {},
      setHome: (id, home) => set((state) => ({ homes: { ...state.homes, [id]: home } })),
      setReferences: (id, references) =>
        set((state) => ({ references: { ...state.references, [id]: references } })),
      setReach: (id, reach) => set((state) => ({ reach: { ...state.reach, [id]: reach } })),
      toggleStrip: (containerKey) =>
        set((state) => {
          const { [containerKey]: open, ...rest } = state.openStrips;
          return { openStrips: open ? rest : { ...rest, [containerKey]: true } };
        }),
    }),
    {
      name: "t3code:home:mapped:v1",
      version: 3,
      storage: prototypeStorage(),
      migrate: migrateMapped,
    },
  ),
);

type MappedSnapshot = {
  readonly [K in keyof MappedOverrides]: MappedOverrides[K][string] | undefined;
};

/** One id's overrides, for undo. */
export function snapshotMapped(id: string): MappedSnapshot {
  const state = useMappedStore.getState();
  return { homes: state.homes[id], references: state.references[id], reach: state.reach[id] };
}

/** Puts one id's overrides back as they were, dropping the ones that weren't set. */
export function restoreMapped(id: string, snapshot: MappedSnapshot) {
  const put = <T>(record: Readonly<Record<string, T>>, value: T | undefined) => {
    const { [id]: _changed, ...rest } = record;
    return value === undefined ? rest : { ...rest, [id]: value };
  };
  useMappedStore.setState((state) => ({
    homes: put(state.homes, snapshot.homes),
    references: put(state.references, snapshot.references),
    reach: put(state.reach, snapshot.reach),
  }));
}
