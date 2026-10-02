/**
 * Access groups: bundles of connections, model accounts, skills, and harness
 * plugins. An agent working in a group only gets that group's members; a
 * sidebar section picks its groups and a chat or task can override them.
 *
 * Roles are open by default, like Google Workspace: members may change every
 * area until an admin restricts it. Model accounts are owned by Usage ›
 * Accounts (CLIProxyAPI pools); groups only reference them.
 */
import type { AccountGroup, PoolAccount, PoolHarness } from "../accounts/accountPoolsModel";
import { POOL_LABEL } from "../accounts/accountPoolsModel";
import {
  isApiKind,
  type AddedBy,
  type ConnectionAccount,
  type GroupId,
  type HarnessId,
  type HarnessPlugin,
  type Integration,
  type Skill,
} from "./pluginsModel";

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

export interface AccessGroup {
  readonly id: GroupId;
  readonly name: string;
  readonly description: string;
  readonly yourRole: "Owner" | "Admin" | "Member";
  /** The organization's domain; set only for org-wide groups. */
  readonly org?: string;
  /** Only the restricted areas; anything missing is open to members. */
  readonly restricted: Partial<Record<PermissionArea, PermissionLevel>>;
}

/** Which sidebar sections use which groups, and how many chats or tasks override them. */
export interface SectionGroupUsage {
  readonly sectionId: string;
  readonly groups: readonly GroupId[];
  readonly overrides: number;
}

export type GroupMemberKind = "connections" | "apis" | "models" | "skills" | "plugins";

export const GROUP_MEMBER_KIND_LABEL: Record<GroupMemberKind, string> = {
  connections: "Connections",
  apis: "APIs",
  models: "Model accounts",
  skills: "Skills",
  plugins: "Codex & Claude plugins",
};

export interface GroupMember {
  readonly key: string;
  readonly kind: GroupMemberKind;
  readonly name: string;
  readonly detail: string;
  readonly glyph?: string;
  readonly harness?: HarnessId;
  readonly groups: readonly GroupId[];
  readonly addedBy: AddedBy;
}

export interface GroupSources {
  readonly integrations: readonly Integration[];
  readonly models: readonly PoolAccount[];
  readonly skills: readonly Skill[];
  readonly plugins: readonly HarnessPlugin[];
}

const POOL_HARNESS: Record<PoolHarness, HarnessId> = {
  codex: "codex",
  claude: "claudeAgent",
  grok: "grok",
};

function accountMember(integration: Integration, account: ConnectionAccount): GroupMember {
  return {
    key: `account:${account.id}`,
    kind: isApiKind(integration.kind) ? "apis" : "connections",
    name: `${integration.name} · ${account.label}`,
    detail: account.identity,
    glyph: integration.glyph,
    groups: account.groups,
    addedBy: account.addedBy,
  };
}

/** Flattens every groupable item into one member list, in display order. */
export function allGroupMembers(sources: GroupSources): readonly GroupMember[] {
  const connections = sources.integrations.flatMap((integration) =>
    integration.accounts.length > 0
      ? integration.accounts.map((account) => accountMember(integration, account))
      : [
          {
            key: `integration:${integration.id}`,
            kind: "connections" as const,
            name: integration.name,
            detail: `Direct MCP · ${integration.transport ?? "stdio"}`,
            glyph: integration.glyph,
            groups: integration.groups ?? [],
            addedBy: "you" as const,
          },
        ],
  );
  // Pool accounts live in Usage › Accounts; a group only lists the ones routed to it.
  const models = sources.models.map((account): GroupMember => ({
    key: `model:${account.id}`,
    kind: "models",
    name: `${POOL_LABEL[account.harness]} · ${account.plan}`,
    detail: account.name,
    harness: POOL_HARNESS[account.harness],
    groups: account.groupIds,
    addedBy: "admins",
  }));
  const skills = sources.skills.map((skill): GroupMember => ({
    key: `skill:${skill.id}`,
    kind: "skills",
    name: skill.name,
    detail: skill.description,
    groups: skill.groups,
    // Members publish skills themselves, so the ones you wrote are yours to pull back.
    addedBy:
      skill.source === "personal" || (skill.source === "team" && skill.origin === "you")
        ? "you"
        : "admins",
  }));
  const plugins = sources.plugins.map((plugin): GroupMember => ({
    key: `plugin:${plugin.id}`,
    kind: "plugins",
    name: plugin.name,
    detail: plugin.description,
    harness: plugin.harness,
    groups: plugin.groups,
    addedBy: "admins",
  }));
  return [...connections, ...models, ...skills, ...plugins];
}

export function membersOfGroup(members: readonly GroupMember[], groupId: GroupId) {
  return members.filter((member) => member.groups.includes(groupId));
}

export function countByKind(members: readonly GroupMember[]): Record<GroupMemberKind, number> {
  const counts: Record<GroupMemberKind, number> = {
    connections: 0,
    apis: 0,
    models: 0,
    skills: 0,
    plugins: 0,
  };
  for (const member of members) counts[member.kind] += 1;
  return counts;
}

export function isRestricted(group: AccessGroup, area: PermissionArea) {
  return group.restricted[area] === "admins";
}

export function hasRestrictions(group: AccessGroup) {
  return PERMISSION_AREAS.some((area) => isRestricted(group, area));
}

/** You can always pull back what you added; the rest follows the area's permission. */
export function canChangeMember(group: AccessGroup, member: GroupMember) {
  if (member.kind === "models") return false;
  return member.addedBy === "you" || !isRestricted(group, member.kind);
}

export function managedLine(group: AccessGroup) {
  return `Managed by ${group.org ?? group.name} admins`;
}

/**
 * The account-group view Usage › Accounts needs, so both pages read one
 * definition of each group. Accounts still owns the accounts themselves.
 */
export function accountGroupsFromAccessGroups(
  groups: readonly AccessGroup[],
  usage: readonly SectionGroupUsage[],
  sectionName: (sectionId: string) => string,
): readonly AccountGroup[] {
  return groups.map((group) => {
    const sections = usage
      .filter((entry) => entry.groups.includes(group.id))
      .map((entry) => sectionName(entry.sectionId));
    return {
      id: group.id,
      label: group.name,
      usedFor: sections.length > 0 ? sections.join(" + ") : "Nothing yet",
      adminManaged: isRestricted(group, "models"),
      ...(isRestricted(group, "models") ? { adminLabel: `${group.name} admins` } : {}),
    };
  });
}
