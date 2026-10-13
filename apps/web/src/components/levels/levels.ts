/**
 * Levels: the Home hierarchy read as an access model. Every thing (thread,
 * automation, place, connection, skill) sits at a level: the top level (you,
 * with Appa), a section (Work, Work › Northwind team, Personal), or a project.
 * Each level has an agent; it coordinates the threads, tasks and automations
 * there (it is not the only agent at its level). An agent can use what sits
 * at its level, and the agents above it coordinate everything below them.
 * Nothing above is visible by default: the lower agent asks the agent above,
 * which represents its own interests and either lends access for the task or
 * does the work itself and hands back only what's needed. A thing can opt to
 * reach `below` (a shared Slack channel, AGENTS.md, model pools): then every
 * level inside its level can use it too, and for pools the nearest one wins.
 *
 * Level keys are Home container keys: `root`, `section:<id>`,
 * `project:<projectKey>`, `team-project:<id>`.
 */
import { TEAM_PROJECTS } from "../multiplayer/multiplayerFixtures";
import { findHomeSection, sectionPathLabel } from "../sidebar/sections/sectionModel";
import { ROOT_CONTAINER_KEY, useHomeSectionStore } from "../sidebar/sections/sectionStore";

export type LevelKey = string;
export const TOP_LEVEL: LevelKey = ROOT_CONTAINER_KEY;

/** The old access groups, now just names for levels. */
export const GROUP_LEVEL: Readonly<Record<string, LevelKey>> = {
  personal: "section:personal",
  work: "section:work",
  northwind: "section:work-northwind",
};

/**
 * Where the Home tree put each real project by default (it knows names and
 * paths, this file only sees keys). Moves still win via `projectSectionOverrides`.
 */
const projectSections = new Map<string, string>();

export function registerProjectSections(sections: ReadonlyMap<string, string>) {
  for (const [projectKey, sectionId] of sections) projectSections.set(projectKey, sectionId);
}

/** Workspace root → Home project key, also registered by the tree. */
const projectRoots = new Map<string, string>();

export function registerProjectRoots(roots: ReadonlyMap<string, string>) {
  for (const [workspaceRoot, projectKey] of roots) projectRoots.set(workspaceRoot, projectKey);
}

/** `environmentId:projectId` of every real project → the Home project it groups under. */
const projectMembers = new Map<string, string>();

export function registerProjectMembers(members: ReadonlyMap<string, string>) {
  for (const [memberKey, projectKey] of members) projectMembers.set(memberKey, projectKey);
}

/** The Home project level a real project (environment + id) sits in, or null before Home knows it. */
export function levelForProject(environmentId: string, projectId: string): LevelKey | null {
  const projectKey = projectMembers.get(`${environmentId}:${projectId}`);
  return projectKey ? `project:${projectKey}` : null;
}

/** The project level a working directory belongs to, or null (e.g. a worktree path). */
export function levelForWorkspace(cwd: string): LevelKey | null {
  const projectKey = projectRoots.get(cwd);
  return projectKey ? `project:${projectKey}` : null;
}

/** Who besides its own level (and those above) may use a thing. */
export type Reach = "here" | "below";

type Placement = Pick<ReturnType<typeof useHomeSectionStore.getState>, "projectSectionOverrides">;

/** The level directly above, or null at the top. Unknown real projects default to Personal. */
export function parentLevel(
  key: LevelKey,
  placement: Placement = useHomeSectionStore.getState(),
): LevelKey | null {
  if (key === TOP_LEVEL) return null;
  if (key.startsWith("section:")) {
    const parentId = findHomeSection(key.slice(8))?.parentId;
    return parentId ? `section:${parentId}` : TOP_LEVEL;
  }
  if (key.startsWith("team-project:")) {
    const id = key.slice(13);
    const sectionId =
      placement.projectSectionOverrides[key] ??
      TEAM_PROJECTS.find((project) => project.id === id)?.sectionId;
    return sectionId ? `section:${sectionId}` : TOP_LEVEL;
  }
  if (key.startsWith("project:")) {
    const projectKey = key.slice(8);
    const sectionId =
      placement.projectSectionOverrides[projectKey] ?? projectSections.get(projectKey);
    return `section:${sectionId ?? "personal"}`;
  }
  // Anything unknown hangs off the top.
  return TOP_LEVEL;
}

/** The level itself, then each one above it up to the top. */
export function levelChain(key: LevelKey, placement?: Placement): readonly LevelKey[] {
  const chain: LevelKey[] = [];
  let current: LevelKey | null = key;
  while (current !== null && !chain.includes(current)) {
    chain.push(current);
    current = parentLevel(current, placement);
  }
  return chain;
}

/**
 * Whether an agent at `agentLevel` may use a thing at `thingLevel`: the thing
 * sits at the agent's level or below it, or reaches `below` from a level above.
 */
export function canUse(
  agentLevel: LevelKey,
  thingLevel: LevelKey,
  placement?: Placement,
  reach: Reach = "here",
): boolean {
  if (levelChain(thingLevel, placement).includes(agentLevel)) return true;
  return reach === "below" && levelChain(agentLevel, placement).includes(thingLevel);
}

/** Whether a thing mapped into several levels is usable from `agentLevel`. */
export function canUseAny(
  agentLevel: LevelKey,
  thingLevels: readonly LevelKey[],
  placement?: Placement,
  reach: Reach = "here",
): boolean {
  return thingLevels.some((level) => canUse(agentLevel, level, placement, reach));
}

/**
 * Lowest level wins: of the candidates on `agentLevel`'s chain (its own level,
 * then each one above), the nearest. How model pools resolve: a project's own
 * pool, else its section's, and so on up. Null when none is on the chain.
 */
export function nearestOnChain(
  agentLevel: LevelKey,
  candidates: readonly LevelKey[],
  placement?: Placement,
): LevelKey | null {
  return levelChain(agentLevel, placement).find((level) => candidates.includes(level)) ?? null;
}

/** The lowest level covering both: whose agent to ask when `agentLevel` can't use the thing. */
export function askLevel(
  agentLevel: LevelKey,
  thingLevel: LevelKey,
  placement?: Placement,
): LevelKey {
  const ours = levelChain(agentLevel, placement);
  return levelChain(thingLevel, placement).find((level) => ours.includes(level)) ?? TOP_LEVEL;
}

/**
 * For a thing mapped into several levels that `agentLevel` can't use: the
 * nearest agent to ask, or null when the agent can already use it (or it sits
 * nowhere). UI code reads this instead of walking chains itself.
 */
export function askLevelAny(
  agentLevel: LevelKey,
  thingLevels: readonly LevelKey[],
  placement?: Placement,
  reach: Reach = "here",
): LevelKey | null {
  if (thingLevels.length === 0 || canUseAny(agentLevel, thingLevels, placement, reach)) return null;
  const ours = levelChain(agentLevel, placement);
  const asks = thingLevels.map((level) => askLevel(agentLevel, level, placement));
  return asks.reduce((nearest, level) =>
    ours.indexOf(level) < ours.indexOf(nearest) ? level : nearest,
  );
}

/** "Work › Northwind team", "Personal", or "Top level"; project keys need a name from the caller. */
export function levelLabel(key: LevelKey, projectName?: string): string {
  if (key === TOP_LEVEL) return "Top level";
  if (key.startsWith("section:")) return sectionPathLabel(key.slice(8));
  if (key.startsWith("team-project:")) {
    const project = TEAM_PROJECTS.find((entry) => entry.id === key.slice(13));
    const parent = parentLevel(key);
    const name = project?.name ?? key.slice(13);
    return parent && parent !== TOP_LEVEL ? `${levelLabel(parent)} › ${name}` : name;
  }
  if (key.startsWith("project:")) {
    const parent = parentLevel(key);
    const name = projectName ?? "Project";
    return parent && parent !== TOP_LEVEL ? `${levelLabel(parent)} › ${name}` : name;
  }
  return key;
}
