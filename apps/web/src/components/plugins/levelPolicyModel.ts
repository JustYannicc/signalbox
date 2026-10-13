/**
 * Who may change what sits at a level. Levels are yours (Owner) unless an
 * organization runs one: then its admins may restrict areas there and in
 * every level below it, like Google Workspace. Open by default: anything not
 * restricted stays open to members. Model accounts are owned by Usage ›
 * Accounts; levels only reference them.
 */
import type { AccountGroup } from "../accounts/accountPoolsModel";
import { levelChain, type LevelKey } from "../levels/levels";
import type { LeveledThing } from "../levels/leveledThings";

export type PermissionArea =
  | "connections"
  | "apis"
  | "models"
  | "plugins"
  | "skills"
  | "instructions"
  | "defaults";

export const PERMISSION_AREAS: readonly PermissionArea[] = [
  "connections",
  "apis",
  "models",
  "plugins",
  "skills",
  "instructions",
  "defaults",
];

export const PERMISSION_AREA_LABEL: Record<PermissionArea, string> = {
  connections: "Connections",
  apis: "APIs",
  models: "Model accounts",
  plugins: "Codex & Claude plugins",
  skills: "Skills",
  instructions: "Instructions",
  defaults: "What newcomers get",
};

/** Who may change an area. Everything is "members" until an admin restricts it. */
export type PermissionLevel = "members" | "admins";

export interface LevelPolicy {
  /** Applies here and to every level below. */
  readonly level: LevelKey;
  readonly yourRole: "Admin" | "Member";
  readonly org: { readonly name: string; readonly domain: string };
  /** Only the restricted areas; anything missing is open to members. */
  readonly restricted: Partial<Record<PermissionArea, PermissionLevel>>;
}

/** The nearest organization policy at or above `level`; none means the level is yours. */
export function policyFor(
  level: LevelKey,
  policies: readonly LevelPolicy[],
): LevelPolicy | undefined {
  for (const key of levelChain(level)) {
    const policy = policies.find((entry) => entry.level === key);
    if (policy) return policy;
  }
  return undefined;
}

export function yourRole(policy: LevelPolicy | undefined) {
  return policy?.yourRole ?? "Owner";
}

export function isRestricted(policy: LevelPolicy | undefined, area: PermissionArea) {
  return policy?.restricted[area] === "admins";
}

export function hasRestrictions(policy: LevelPolicy | undefined) {
  return PERMISSION_AREAS.some((area) => isRestricted(policy, area));
}

/** You can always pull back what you added; the rest follows the area's permission. */
export function canChangeThing(policy: LevelPolicy | undefined, thing: LeveledThing) {
  if (thing.kind === "models") return false;
  if (thing.kind === "automations" || thing.kind === "places") return true;
  return thing.addedBy !== "admins" || !isRestricted(policy, thing.kind);
}

export function managedLine(policy: LevelPolicy) {
  return `Managed by ${policy.org.name} admins`;
}

/** The groups a pool can be shared with (people at a level), from the old group ids. */
export function accountGroupsFromLevels(
  groupLevels: Readonly<Record<string, LevelKey>>,
  labelFor: (level: LevelKey) => string,
): readonly AccountGroup[] {
  return Object.entries(groupLevels).map(([id, level]) => ({ id, level, label: labelFor(level) }));
}

/**
 * Who manages a model account sitting at `levels`: the org's admins when every
 * level restricts models to them, otherwise null (your own level keeps it yours).
 */
export function modelAccountManager(
  levels: readonly LevelKey[],
  policies: readonly LevelPolicy[],
): string | null {
  const managing = levels.map((level) => policyFor(level, policies));
  if (managing.length === 0 || !managing.every((policy) => isRestricted(policy, "models"))) {
    return null;
  }
  return managing[0] ? `${managing[0].org.name} admins` : null;
}
