/**
 * What newcomers get: what a team or project hands a member automatically.
 * Sharing scope is not part of it; containers own that in their share editor.
 * A project
 * inherits its team's preset and lists only what it adds, removes, or
 * overrides. Connections are either a shared company account or a slot each
 * member fills with their own account.
 */
import type { GroupId, HarnessId } from "./pluginsModel";

export type DefaultsKind = "skills" | "connections" | "plugins" | "instructions" | "models";

export const DEFAULTS_KIND_LABEL: Record<DefaultsKind, string> = {
  skills: "Skills",
  connections: "Executor connections",
  plugins: "Harness plugins",
  instructions: "Thread-agent instructions",
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
  readonly id: string;
  readonly name: string;
  readonly kind: "team" | "project";
  /** The team preset a project starts from. */
  readonly inherits?: string;
  /** The group whose admin rules apply to editing this preset. */
  readonly groupId: GroupId;
  readonly items: readonly DefaultItem[];
  /** Inherited item ids this project drops. */
  readonly removes: readonly string[];
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

/** Team items first, then the project's own; removed ones stay visible so the override reads. */
export function resolvePreset(
  preset: DefaultsPreset,
  presets: readonly DefaultsPreset[],
): ResolvedPreset {
  const parent = preset.inherits
    ? presets.find((entry) => entry.id === preset.inherits)
    : undefined;
  const inherited: ResolvedItem[] = (parent?.items ?? []).map((item) => ({
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
