/**
 * Placeholder model for Home sections: folders that group projects (Sections ›
 * Projects › items). Nothing here is persisted server-side yet; the default
 * sections, their agents, and the loose items are fixtures. Sections you
 * create, rename, or move live in `sectionStore`; the lookups below merge them
 * in, so every caller sees the tree as you arranged it.
 */
import type { HomeItemStatus } from "./homeStatus";
import { useHomeSectionStore } from "./sectionStore";

export interface HomeSection {
  readonly id: string;
  readonly name: string;
  /** Stable, unique id for this section's agent (`/agent/$agentId`). */
  readonly agentId: string;
  /** `null` for a root section. Sections nest to any depth. */
  readonly parentId: string | null;
  /** Your agent for this section; agents are always personal, even in a team. */
  readonly agentName: string;
  /** Fixture: what your agent for this section is doing. */
  readonly agentStatus: HomeItemStatus | null;
  /**
   * A team section is shared with its members; folders are just yours. Kind
   * never decides visibility on its own: `defaultScope` does.
   */
  readonly kind: "folder" | "team";
  /** Where new items start, and what markers are measured against. */
  readonly defaultScope: "private" | "shared";
  /** Set for team sections; see `components/multiplayer`. */
  readonly teamId?: string;
}

export const HOME_SECTIONS: readonly HomeSection[] = [
  {
    id: "work",
    name: "Work",
    agentId: "section-work",
    parentId: null,
    agentName: "Work agent",
    agentStatus: null,
    kind: "folder",
    defaultScope: "private",
  },
  {
    id: "work-northwind",
    name: "Northwind team",
    agentId: "section-northwind",
    parentId: "work",
    agentName: "Northwind agent",
    agentStatus: "working",
    kind: "team",
    defaultScope: "shared",
    teamId: "northwind",
  },
  {
    id: "personal",
    name: "Personal",
    agentId: "section-personal",
    parentId: null,
    agentName: "Personal agent",
    agentStatus: "input",
    kind: "folder",
    defaultScope: "private",
  },
];

type SectionState = ReturnType<typeof useHomeSectionStore.getState>;
let cache: {
  userSections: SectionState["userSections"];
  sectionParents: SectionState["sectionParents"];
  names: SectionState["names"];
  list: readonly HomeSection[];
  byId: ReadonlyMap<string, HomeSection>;
} | null = null;

/** Fixture sections plus yours, with your renames and moves applied. */
export function allHomeSections(): readonly HomeSection[] {
  const { userSections, sectionParents, names } = useHomeSectionStore.getState();
  if (
    cache?.userSections === userSections &&
    cache.sectionParents === sectionParents &&
    cache.names === names
  ) {
    return cache.list;
  }
  const list: HomeSection[] = [
    ...HOME_SECTIONS.map((section) => ({
      ...section,
      name: names[`section:${section.id}`] ?? section.name,
      parentId:
        section.id in sectionParents ? (sectionParents[section.id] ?? null) : section.parentId,
    })),
    ...Object.entries(userSections).map(([id, section]): HomeSection => ({
      id,
      name: section.name,
      agentId: `section-${id}`,
      parentId: section.parentId,
      agentName: `${section.name} agent`,
      agentStatus: null,
      kind: "folder",
      defaultScope: "private",
    })),
  ];
  cache = {
    userSections,
    sectionParents,
    names,
    list,
    byId: new Map(list.map((section) => [section.id, section] as const)),
  };
  return list;
}

export function findHomeSection(sectionId: string): HomeSection | undefined {
  allHomeSections();
  return cache?.byId.get(sectionId);
}

export function childSectionsOf(parentId: string | null): readonly HomeSection[] {
  return allHomeSections().filter((section) => section.parentId === parentId);
}

/** The root section a section belongs to, which is what Focus hides or shows. */
export function rootSectionIdOf(sectionId: string): string {
  let section = findHomeSection(sectionId);
  const seen = new Set<string>();
  while (section?.parentId && !seen.has(section.id)) {
    seen.add(section.id);
    section = findHomeSection(section.parentId);
  }
  return section?.id ?? sectionId;
}

/** Whether `candidateId` is `sectionId` or sits somewhere below it. */
export function isSectionWithin(candidateId: string, sectionId: string): boolean {
  let current = findHomeSection(candidateId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (current.id === sectionId) return true;
    seen.add(current.id);
    current = current.parentId ? findHomeSection(current.parentId) : undefined;
  }
  return false;
}

/** "Work › Northwind team", for pickers that list every section flat. */
export function sectionPathLabel(sectionId: string): string {
  const labels: string[] = [];
  let section = findHomeSection(sectionId);
  const seen = new Set<string>();
  while (section && !seen.has(section.id)) {
    seen.add(section.id);
    labels.unshift(section.name);
    section = section.parentId ? findHomeSection(section.parentId) : undefined;
  }
  return labels.join(" › ");
}

/** Placeholder placement until sections are real: Northwind work goes to Work › Northwind team. */
export function defaultSectionIdForProject(project: {
  readonly displayName: string;
  readonly workspaceRoot: string;
}): string {
  const haystack = `${project.displayName} ${project.workspaceRoot}`.toLowerCase();
  return haystack.includes("northwind") ? "work-northwind" : "personal";
}

function slug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "project"
  );
}

/** A section's agent id; prefer `HomeSection.agentId` when you have the section. */
export function sectionAgentId(sectionId: string): string {
  return findHomeSection(sectionId)?.agentId ?? `section-${sectionId}`;
}

/**
 * The readable agent id for a project name (`project-terminal-app`). The Home
 * tree de-duplicates with `assignProjectAgentIds`; use this where one name is
 * all you have.
 */
export function projectAgentId(projectName: string): string {
  return `project-${slug(projectName)}`;
}

/**
 * Stable, unique project agent ids. Readable slugs (`project-terminal-app`)
 * keep the agent fixtures resolvable; a collision gets the project key as a
 * suffix instead of silently sharing an agent.
 */
export function assignProjectAgentIds(
  projects: ReadonlyArray<{ readonly key: string; readonly name: string }>,
): ReadonlyMap<string, string> {
  const used = new Set<string>();
  const ids = new Map<string, string>();
  for (const project of projects) {
    let id = `project-${slug(project.name)}`;
    if (used.has(id)) id = `${id}-${slug(project.key)}`;
    used.add(id);
    ids.set(project.key, id);
  }
  return ids;
}

/**
 * A chat or task that sits directly in a section (or at the top level) rather
 * than in a project. Fixture data; it behaves like any other thread.
 */
export interface LooseItem {
  readonly id: string;
  readonly title: string;
  readonly type: "chat" | "task";
  /** Section id, or `null` for the top level. */
  readonly sectionId: string | null;
  readonly lastActiveAt: string;
  /** Starting visibility; the user's change lives in the shared visibility store. */
  readonly scope: "private" | "shared";
  readonly status?: HomeItemStatus;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

export const LOOSE_ITEMS: readonly LooseItem[] = [
  {
    id: "chat-okr-draft",
    title: "Draft Q4 OKRs for the team",
    type: "chat",
    sectionId: "work",
    lastActiveAt: daysAgo(0.2),
    scope: "private",
  },
  {
    id: "task-expense-report",
    title: "Submit September expense report",
    type: "task",
    sectionId: "work",
    lastActiveAt: daysAgo(0.1),
    scope: "private",
    status: "input",
  },
  {
    id: "chat-terminal-rollout",
    title: "Which terminals get the rollout first?",
    type: "chat",
    sectionId: "work-northwind",
    lastActiveAt: daysAgo(4),
    scope: "private",
  },
  {
    id: "chat-lisbon",
    title: "Lisbon offsite ideas",
    type: "chat",
    sectionId: "personal",
    lastActiveAt: daysAgo(2),
    scope: "shared",
  },
  {
    id: "task-tax-return",
    title: "File the tax return",
    type: "task",
    sectionId: "personal",
    lastActiveAt: daysAgo(1),
    scope: "private",
    status: "plan",
  },
  {
    id: "chat-schema-question",
    title: "How does Schema.fromJsonString decode?",
    type: "chat",
    sectionId: null,
    lastActiveAt: daysAgo(5),
    scope: "private",
  },
];

let looseCache: {
  userLooseItems: SectionState["userLooseItems"];
  list: readonly LooseItem[];
} | null = null;

/** Fixture loose items plus the unfiled chats and tasks you created (top level, private). */
export function allLooseItems(): readonly LooseItem[] {
  const { userLooseItems } = useHomeSectionStore.getState();
  if (looseCache?.userLooseItems === userLooseItems) return looseCache.list;
  const list: LooseItem[] = [
    ...Object.entries(userLooseItems).map(([id, item]): LooseItem => ({
      id,
      title: item.title,
      type: item.kind,
      sectionId: null,
      lastActiveAt: item.createdAt,
      scope: "private",
    })),
    ...LOOSE_ITEMS.filter((item) => !(item.id in userLooseItems)),
  ];
  looseCache = { userLooseItems, list };
  return list;
}

/** A loose item by id, fixture or yours; what `/shared/<id>` should resolve with. */
export function findLooseItem(id: string): LooseItem | undefined {
  return allLooseItems().find((item) => item.id === id);
}
