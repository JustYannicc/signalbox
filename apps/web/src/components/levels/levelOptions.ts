/**
 * Every Home level a thing can sit at, in tree order: the top level, each
 * section, and each project (team and real) under its section, labelled with
 * its folder path ("Work › Northwind team › terminal-app"). Pickers list these;
 * an agent finds its own level by `agentId`. Pure: `LevelOptionsProvider`
 * feeds it the live sections and projects.
 */
import { TEAM_PROJECTS } from "../multiplayer/multiplayerFixtures";
import {
  assignProjectAgentIds,
  defaultSectionIdForProject,
  findHomeSection,
  type HomeSection,
} from "../sidebar/sections/sectionModel";
import { TOP_LEVEL, type LevelKey } from "./levels";

export interface LevelOption {
  readonly key: LevelKey;
  readonly kind: "root" | "section" | "project";
  /** Last path segment: "Northwind team", "terminal-app", "Top level". */
  readonly name: string;
  /** Folder path: "Work › Northwind team". */
  readonly label: string;
  readonly depth: number;
  /** The agent that represents this level; null at the top, where it is the assistant. */
  readonly agentId: string | null;
  readonly agentName: string | null;
}

export interface LevelProject {
  readonly projectKey: string;
  readonly displayName: string;
  readonly workspaceRoot: string;
}

export interface LevelPlacementInput {
  readonly projectSectionOverrides: Readonly<Record<string, string>>;
  readonly names: Readonly<Record<string, string>>;
}

export const TOP_LEVEL_OPTION: LevelOption = {
  key: TOP_LEVEL,
  kind: "root",
  name: "Top level",
  label: "Top level",
  depth: 0,
  agentId: null,
  agentName: null,
};

export function buildLevelOptions(input: {
  sections: readonly HomeSection[];
  projects: readonly LevelProject[];
  placement: LevelPlacementInput;
}): readonly LevelOption[] {
  const { sections, projects, placement } = input;
  // Same agent ids as the Home tree: team projects claim their readable ids first.
  const agentIds = assignProjectAgentIds([
    ...TEAM_PROJECTS.map((project) => ({ key: `team-project:${project.id}`, name: project.id })),
    ...projects.map((project) => ({
      key: project.projectKey,
      name: placement.names[`project:${project.projectKey}`] ?? project.displayName,
    })),
  ]);
  const projectsBySection = new Map<string, { key: LevelKey; name: string; agentId: string }[]>();
  const addProject = (sectionId: string, entry: { key: LevelKey; name: string; agentId: string }) =>
    projectsBySection.set(sectionId, [...(projectsBySection.get(sectionId) ?? []), entry]);
  for (const project of TEAM_PROJECTS) {
    const key = `team-project:${project.id}`;
    addProject(placement.projectSectionOverrides[key] ?? project.sectionId, {
      key,
      name: placement.names[key] ?? project.name,
      agentId: agentIds.get(key) ?? `project-${project.id}`,
    });
  }
  for (const project of projects) {
    const override = placement.projectSectionOverrides[project.projectKey];
    const sectionId =
      override && findHomeSection(override) ? override : defaultSectionIdForProject(project);
    addProject(sectionId, {
      key: `project:${project.projectKey}`,
      name: placement.names[`project:${project.projectKey}`] ?? project.displayName,
      agentId: agentIds.get(project.projectKey) ?? `project-${project.projectKey}`,
    });
  }

  const options: LevelOption[] = [TOP_LEVEL_OPTION];
  const visit = (section: HomeSection, path: string, depth: number) => {
    const label = path ? `${path} › ${section.name}` : section.name;
    options.push({
      key: `section:${section.id}`,
      kind: "section",
      name: section.name,
      label,
      depth,
      agentId: section.agentId,
      agentName: section.agentName,
    });
    for (const child of sections.filter((entry) => entry.parentId === section.id)) {
      visit(child, label, depth + 1);
    }
    for (const project of projectsBySection.get(section.id) ?? []) {
      options.push({
        key: project.key,
        kind: "project",
        name: project.name,
        label: `${label} › ${project.name}`,
        depth: depth + 1,
        agentId: project.agentId,
        agentName: `${project.name} agent`,
      });
    }
  };
  for (const root of sections.filter((section) => section.parentId === null)) visit(root, "", 1);
  return options;
}
