/**
 * Default visibility per container. Teams, team sections and team projects
 * default to Shared; folders (Personal, Work) default to Private. New items
 * inherit the default; an item that differs is a deviation the Home tree marks.
 * Import these through `sharing.ts`.
 */
import {
  HOME_SECTIONS,
  findHomeSection,
  projectAgentId,
  sectionAgentId,
} from "../sidebar/sections/sectionModel";
import { TEAMS, TEAM_PROJECTS } from "./multiplayerFixtures";
import type { ThreadVisibility } from "./multiplayerModel";

export interface ContainerInfo {
  readonly id: string;
  readonly name: string;
  /** The team whose members "shared" means; `null` for personal containers. */
  readonly teamId: string | null;
  readonly defaultScope: ThreadVisibility;
}

function sectionTeamId(sectionId: string): string | null {
  let section = findHomeSection(sectionId);
  while (section) {
    if (section.kind === "team" && section.teamId) return section.teamId;
    section = section.parentId ? findHomeSection(section.parentId) : undefined;
  }
  return null;
}

/**
 * Accepts a team id, a Home section id, a team project id, `"home"`, or a Home
 * container key (`section:<id>`, `team-project:<id>`).
 */
export function containerInfo(containerIdOrKey: string): ContainerInfo {
  const containerId = containerIdOrKey.replace(/^(section|team-project):/, "");
  const team = TEAMS.find((candidate) => candidate.id === containerId);
  if (team) return { id: team.id, name: team.name, teamId: team.id, defaultScope: "shared" };
  const project = TEAM_PROJECTS.find((candidate) => candidate.id === containerId);
  if (project) {
    return { id: project.id, name: project.name, teamId: project.teamId, defaultScope: "shared" };
  }
  const section = findHomeSection(containerId);
  const teamId = sectionTeamId(containerId);
  return {
    id: containerId,
    // "home" is the top level, where loose items without a section live.
    name: section?.name ?? (containerId === "home" ? "Home" : containerId),
    teamId,
    defaultScope: teamId ? "shared" : "private",
  };
}

/** The Home section a container sits in: the project's section, the team's section. */
export function containerSectionId(containerIdOrKey: string): string | null {
  const containerId = containerIdOrKey.replace(/^(section|team-project):/, "");
  const project = TEAM_PROJECTS.find((candidate) => candidate.id === containerId);
  if (project) return project.sectionId;
  if (findHomeSection(containerId)) return containerId;
  return HOME_SECTIONS.find((section) => section.teamId === containerId)?.id ?? null;
}

/**
 * Your agent for a container (agents are personal): the project agent for a
 * team project, else the section agent. `null` at the top level.
 */
export function containerAgentId(containerIdOrKey: string): string | null {
  const containerId = containerIdOrKey.replace(/^(section|team-project):/, "");
  const project = TEAM_PROJECTS.find((candidate) => candidate.id === containerId);
  if (project) return projectAgentId(project.name);
  const sectionId = containerSectionId(containerId);
  return sectionId ? sectionAgentId(sectionId) : null;
}

export function defaultScopeFor(containerId: string): ThreadVisibility {
  return containerInfo(containerId).defaultScope;
}

/**
 * Where an item starts. Rooms always start with just their two owners: what
 * an assistant shared there was cleared by its owner's policy for that one
 * person, whatever the container's default.
 */
export function defaultScopeForItem(
  kind: "chat" | "task" | "room" | undefined,
  containerId: string,
): ThreadVisibility {
  return kind === "room" ? "private" : defaultScopeFor(containerId);
}

export type ScopeDeviation = "private-in-shared" | "shared-in-private";

export interface ScopedItem {
  /** Section id, team project id, team id, or Home container key the item lives in. */
  readonly containerId: string;
  readonly visibility: ThreadVisibility;
  /** People added to this item directly, beyond its owners. */
  readonly grantedIds?: readonly string[];
  /** Rooms default to private in any container. */
  readonly kind?: "chat" | "task" | "room";
}

/**
 * `"private-in-shared"`: private in a container that defaults to shared (show a
 * lock). `"shared-in-private"`: shared with the team or specific people in a
 * container that defaults to private (show a people count). `null`: follows
 * the default, show nothing.
 */
export function scopeDeviation(item: ScopedItem): ScopeDeviation | null {
  const isShared = item.visibility === "shared" || (item.grantedIds?.length ?? 0) > 0;
  const defaultScope = defaultScopeForItem(item.kind, item.containerId);
  if (defaultScope === "shared" && item.visibility === "private") return "private-in-shared";
  if (defaultScope === "private" && isShared) return "shared-in-private";
  return null;
}
