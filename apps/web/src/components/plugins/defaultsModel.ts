/**
 * What newcomers get: what a team level (a team section or a project in it)
 * hands a new member automatically. This is the people axis: onboarding, not
 * access. One preset per level, keyed by its level; a preset inherits the
 * nearest preset above its level and lists only what it adds or removes.
 * Sharing scope is not part of it; containers own that in their share editor.
 * Connections are either a shared company account or a slot each member
 * fills with their own account.
 */
import { nearestOnChain, parentLevel, type LevelKey } from "../levels/levels";
import type { HarnessId } from "./pluginsModel";

export type DefaultsKind = "skills" | "connections" | "plugins" | "instructions" | "models";

export const DEFAULTS_KIND_LABEL: Record<DefaultsKind, string> = {
  skills: "Skills",
  connections: "Executor connections",
  plugins: "Harness plugins",
  instructions: "Instructions (AGENTS.md)",
  models: "Model account pool",
};

export const DEFAULTS_KINDS: readonly DefaultsKind[] = [
  "connections",
  "skills",
  "plugins",
  "instructions",
  "models",
];

export interface DefaultItem {
  readonly id: string;
  readonly kind: DefaultsKind;
  readonly name: string;
  readonly detail: string;
  readonly glyph?: string;
  readonly harness?: HarnessId;
  /** Connections only: a shared company account, or a slot each member fills. */
  readonly connection?: "shared" | "own";
  /** Own-account slots a member can skip without breaking the project. */
  readonly optional?: boolean;
}

export interface DefaultsPreset {
  /** Its level key: one preset per level. */
  readonly id: LevelKey;
  /** The Home level it belongs to (same as `id`); that level's admin rules apply to editing it. */
  readonly level: LevelKey;
  readonly name: string;
  readonly items: readonly DefaultItem[];
  /** Inherited item ids this level drops. */
  readonly removes: readonly string[];
}

type Placement = Parameters<typeof parentLevel>[1];

/** Sections are teams; everything below them is a project. */
export function presetKind(preset: DefaultsPreset): "team" | "project" {
  return preset.level.startsWith("section:") ? "team" : "project";
}

/** The preset this one inherits: the nearest one above its level, if any. */
export function inheritedPreset(
  preset: DefaultsPreset,
  presets: readonly DefaultsPreset[],
  placement?: Placement,
): DefaultsPreset | undefined {
  const above = parentLevel(preset.level, placement);
  if (above === null) return undefined;
  const level = nearestOnChain(
    above,
    presets.map((entry) => entry.level),
    placement,
  );
  return presets.find((entry) => entry.level === level);
}

export type ItemOrigin = "inherited" | "added" | "removed" | "own";

export interface ResolvedItem {
  readonly item: DefaultItem;
  readonly origin: ItemOrigin;
}

export interface ResolvedPreset {
  readonly preset: DefaultsPreset;
  readonly parent: DefaultsPreset | undefined;
  readonly items: readonly ResolvedItem[];
  readonly overrideCount: number;
}

/**
 * Everything inherited first, then the level's own; removed ones stay visible
 * so the override reads. Inheritance chains: a project under a sub-team gets
 * what the sub-team resolved to, minus its own removals.
 */
export function resolvePreset(
  preset: DefaultsPreset,
  presets: readonly DefaultsPreset[],
  placement?: Placement,
): ResolvedPreset {
  const parent = inheritedPreset(preset, presets, placement);
  const parentItems = parent
    ? resolvePreset(parent, presets, placement)
        .items.filter((entry) => entry.origin !== "removed")
        .map((entry) => entry.item)
    : [];
  const inherited: ResolvedItem[] = parentItems.map((item) => ({
    item,
    origin: preset.removes.includes(item.id) ? "removed" : "inherited",
  }));
  const own: ResolvedItem[] = preset.items.map((item) => ({
    item,
    origin: parent ? "added" : "own",
  }));
  const overrideCount =
    (parent ? own.length : 0) + inherited.filter((entry) => entry.origin === "removed").length;
  return { preset, parent, items: [...inherited, ...own], overrideCount };
}

/** What a new member gets without doing anything, and what they must connect themselves. */
export function newcomerSplit(resolved: ResolvedPreset) {
  const active = resolved.items.filter((entry) => entry.origin !== "removed");
  return {
    ready: active.filter((entry) => entry.item.connection !== "own"),
    toConnect: active.filter((entry) => entry.item.connection === "own"),
  };
}
