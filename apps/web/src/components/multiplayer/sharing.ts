/**
 * Drive-style access: a team grants access, its projects inherit it, and each
 * item (chat, task or room) inherits from its container unless it is private.
 * Direct grants add people to one item, in any container. Placeholder:
 * computed from fixtures plus local stores, never sent anywhere.
 */
import { containerInfo } from "./containerScope";
import { firstName, type TeamPerson, type ThreadVisibility } from "./multiplayerModel";
import { currentPerson, findTeam, peopleByIds } from "./teamThreads";

export {
  containerInfo,
  defaultScopeFor,
  defaultScopeForItem,
  scopeDeviation,
  type ContainerInfo,
  type ScopeDeviation,
  type ScopedItem,
} from "./containerScope";

export type ShareRole = "owner" | "reply" | "view";

export const SHARE_ROLE_LABEL: Record<ShareRole, string> = {
  owner: "Owner",
  reply: "Can reply",
  view: "Viewer",
};

/** Anything with its own access: a chat, task or room, in any container. */
export interface AccessItem {
  readonly id: string;
  readonly title: string;
  readonly kind: "chat" | "task" | "room";
  /** Team id, Home section id, or team project id. */
  readonly containerId: string;
  /** Always have access; the first one started it. */
  readonly ownerIds: readonly string[];
  /** Non-owners who posted. Their turns are why a shared item can't go private. */
  readonly repliedIds: readonly string[];
  readonly visibility: ThreadVisibility;
  /** People added directly, beyond the owners. */
  readonly grantedIds: readonly string[];
  /** Roles the user changed on direct grants. */
  readonly roles: Readonly<Record<string, ShareRole>>;
  /** Pending email invites from outside the team. */
  readonly invites: readonly string[];
}

/**
 * The team "shared" means: the container's team. `null` for teamless
 * containers (Personal, Home), where general access is only "people added".
 */
export function sharingTeamId(containerId: string): string | null {
  return containerInfo(containerId).teamId;
}

/** Owners, then direct grants, then the team when shared; no duplicates. */
export function peopleWithAccess(item: AccessItem): readonly TeamPerson[] {
  const teamId = sharingTeamId(item.containerId);
  const teamIds = item.visibility === "shared" && teamId ? (findTeam(teamId)?.memberIds ?? []) : [];
  return peopleByIds([...new Set([...item.ownerIds, ...item.grantedIds, ...teamIds])]);
}

export function hasAccess(item: AccessItem, personId: string): boolean {
  return peopleWithAccess(item).some((person) => person.id === personId);
}

export type ShareTarget =
  | { readonly kind: "item"; readonly item: AccessItem }
  | { readonly kind: "team"; readonly teamId: string }
  | { readonly kind: "project"; readonly name: string; readonly teamId: string };

export type AccessPrincipal =
  | { readonly kind: "person"; readonly person: TeamPerson }
  | { readonly kind: "group"; readonly name: string; readonly memberCount: number }
  | { readonly kind: "invite"; readonly email: string };

export interface AccessRow {
  readonly key: string;
  readonly principal: AccessPrincipal;
  readonly role: ShareRole;
  /** Where the grant comes from; inherited rows are changed on that item. */
  readonly inheritedFrom: string | null;
  /** A direct grant on this item: its role can change and it can be removed. */
  readonly editable?: boolean;
}

export interface AccessSummary {
  readonly title: string;
  readonly description: string;
  readonly rows: readonly AccessRow[];
  readonly general: {
    readonly scope: "team" | "restricted";
    readonly label: string;
    readonly detail: string;
  };
}

/** A person's role from their team role; guests only ever view. */
export const TEAM_ROLE: Record<TeamPerson["role"], ShareRole> = {
  Owner: "owner",
  Admin: "reply",
  Member: "reply",
  Guest: "view",
};

function personRow(person: TeamPerson, role: ShareRole, inheritedFrom: string | null): AccessRow {
  return { key: `person:${person.id}`, principal: { kind: "person", person }, role, inheritedFrom };
}

/** Default role for someone added directly: their team role, never owner. */
export function grantRole(person: TeamPerson): ShareRole {
  const role = TEAM_ROLE[person.role];
  return role === "owner" ? "reply" : role;
}

function itemAccess(item: AccessItem): AccessSummary {
  const container = containerInfo(item.containerId);
  const teamId = sharingTeamId(item.containerId);
  const team = teamId ? findTeam(teamId) : undefined;
  const owners = peopleByIds(item.ownerIds);
  const granted = peopleByIds(item.grantedIds.filter((id) => !item.ownerIds.includes(id)));
  const isShared = item.visibility === "shared" && team !== undefined;
  const rows: AccessRow[] = [
    ...owners.map((person) => personRow(person, "owner", null)),
    ...granted.map((person) => ({
      ...personRow(person, item.roles[person.id] ?? grantRole(person), null),
      editable: true,
    })),
  ];
  for (const email of item.invites) {
    rows.push({
      key: `invite:${email}`,
      principal: { kind: "invite", email },
      role: "reply",
      inheritedFrom: null,
    });
  }
  if (isShared && team) {
    rows.push({
      key: `group:${team.id}`,
      principal: { kind: "group", name: team.name, memberCount: team.memberIds.length },
      role: "reply",
      inheritedFrom: container.defaultScope === "shared" ? container.name : null,
    });
  }
  const defaultScope = item.kind === "room" ? "private" : container.defaultScope;
  const detail = !team
    ? `${container.name} has no team`
    : item.kind === "room"
      ? "Rooms start with just their two owners"
      : defaultScope === item.visibility
        ? `Same as ${container.name}`
        : `${container.name} defaults to ${defaultScope}`;
  return {
    title: `Share "${item.title}"`,
    description: "",
    rows,
    general:
      isShared && team
        ? { scope: "team", label: `Anyone in ${team.name}`, detail }
        : { scope: "restricted", label: "Only people added", detail },
  };
}

/** The team's owner, for project rows. */
function teamOwner(teamId: string): TeamPerson {
  const members = peopleByIds(findTeam(teamId)?.memberIds ?? []);
  return members.find((person) => person.role === "Owner") ?? members[0] ?? currentPerson;
}

export function accessFor(target: ShareTarget): AccessSummary {
  if (target.kind === "item") return itemAccess(target.item);
  const team = findTeam(target.teamId);
  const teamName = team?.name ?? "your team";
  const members = peopleByIds(team?.memberIds ?? []);

  if (target.kind === "team") {
    return {
      title: `Share ${teamName}`,
      description: "Projects and shared items in this team inherit these people.",
      rows: members.map((person) => personRow(person, TEAM_ROLE[person.role], null)),
      general: { scope: "restricted", label: "Only people added", detail: "Invite by email" },
    };
  }

  return {
    title: `Share ${target.name}`,
    description: "",
    rows: [
      personRow(teamOwner(target.teamId), "owner", teamName),
      {
        key: `group:${target.teamId}`,
        principal: { kind: "group", name: teamName, memberCount: members.length },
        role: "reply",
        inheritedFrom: teamName,
      },
    ],
    general: {
      scope: "team",
      label: `Anyone in ${teamName}`,
      detail: `Inherited from ${teamName}`,
    },
  };
}

/** "Flynn, Samir and Leona". */
export function joinNames(people: readonly TeamPerson[], fallback: string): string {
  const names = people.map((person) => firstName(person.name));
  if (names.length <= 1) return names[0] ?? fallback;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "Flynn, Samir and Leona": everyone else on the team, for the share confirmation. */
export function othersOnTeam(teamId: string): string {
  const others = peopleByIds(findTeam(teamId)?.memberIds ?? []).filter(
    (person) => person.id !== currentPerson.id,
  );
  return joinNames(others, "Your team");
}
