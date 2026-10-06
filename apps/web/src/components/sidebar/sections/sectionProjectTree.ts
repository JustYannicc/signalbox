import type { SectionTree, SectionTreeNode } from "@t3tools/client-runtime/state/sections";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../../sidebarProjectGrouping";
import type { EnvironmentSectionsView } from "../../../state/sections";

export interface SectionSidebarProject {
  readonly id: SidebarProjectSnapshot["id"];
  readonly sidebarProjectKey: string;
  readonly project: SidebarProjectSnapshot;
  readonly sectionId: string | null;
}

export interface SectionSidebarEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly snapshot: EnvironmentSectionsView["snapshot"];
  readonly orderedProjects: ReadonlyArray<OrchestrationProjectShell>;
  readonly tree: SectionTree<SectionSidebarProject>;
}

export interface SectionSidebarVisibleProjectRow {
  readonly environmentId: EnvironmentId;
  readonly project: SectionSidebarProject;
}

function hasSavedSectionSidebarState(environment: SectionSidebarEnvironment): boolean {
  return (
    (environment.snapshot?.sections.length ?? 0) > 0 ||
    (environment.snapshot?.projectPlacements.length ?? 0) > 0
  );
}

export function hasAnySavedSectionSidebarState(
  environments: ReadonlyArray<SectionSidebarEnvironment>,
): boolean {
  return environments.some(hasSavedSectionSidebarState);
}

export function sectionSidebarSectionKey(environmentId: EnvironmentId, sectionId: string): string {
  return `section:${environmentId}:${sectionId}`;
}

export function visibleSectionProjectRows(
  environments: ReadonlyArray<SectionSidebarEnvironment>,
  collapsedSections: ReadonlySet<string>,
): SectionSidebarVisibleProjectRow[] {
  const rows: SectionSidebarVisibleProjectRow[] = [];
  const visit = (
    environment: SectionSidebarEnvironment,
    node: SectionTreeNode<SectionSidebarProject>,
  ) => {
    if (
      collapsedSections.has(sectionSidebarSectionKey(environment.environmentId, node.section.id))
    ) {
      return;
    }
    for (const child of node.childSections) visit(environment, child);
    for (const project of node.projects) {
      rows.push({ environmentId: environment.environmentId, project });
    }
  };

  for (const environment of environments) {
    for (const node of environment.tree.roots) visit(environment, node);
    for (const project of [
      ...environment.tree.rootProjects,
      ...environment.tree.unplacedProjects,
    ]) {
      rows.push({ environmentId: environment.environmentId, project });
    }
  }
  return rows;
}

interface SectionSidebarRowInput {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly isDesktopLocalEnvironment: boolean;
  readonly isWslEnvironment: boolean;
  readonly environmentLabel: string;
}

function groupedRows(
  environmentId: EnvironmentId,
  projects: ReadonlyArray<OrchestrationProjectShell>,
  sectionId: string | null,
  groupByProjectId: ReadonlyMap<string, SidebarProjectSnapshot>,
  input: SectionSidebarRowInput,
): SectionSidebarProject[] {
  const grouped = new Map<
    string,
    { readonly source: SidebarProjectSnapshot; readonly member: SidebarProjectGroupMember }
  >();
  for (const project of projects) {
    const source = groupByProjectId.get(
      scopedProjectKey(scopeProjectRef(environmentId, project.id)),
    );
    if (!source) continue;
    const member = source.memberProjects.find(
      (candidate) => candidate.environmentId === environmentId && candidate.id === project.id,
    );
    if (member)
      grouped.set(`${source.projectKey}:${member.environmentId}:${member.id}`, { source, member });
  }

  return Array.from(grouped.values()).flatMap(({ source, member }) => {
    const sameEnvironmentCount = source.memberProjects.filter(
      (candidate) => candidate.environmentId === member.environmentId,
    ).length;
    const pathName = member.workspaceRoot.split(/[\\/]/).findLast((part) => part.length > 0);
    const displayName =
      sameEnvironmentCount > 1 && pathName
        ? `${source.displayName} · ${pathName}`
        : source.displayName;
    const isRemote =
      input.primaryEnvironmentId !== null && member.environmentId !== input.primaryEnvironmentId;
    const project: SidebarProjectSnapshot = {
      ...source,
      ...member,
      projectKey: source.projectKey,
      displayName,
      groupedProjectCount: 1,
      environmentPresence: isRemote ? "remote-only" : "local-only",
      allRemoteMembersAreDesktopLocal: isRemote && input.isDesktopLocalEnvironment,
      allRemoteMembersAreWsl: isRemote && input.isWslEnvironment,
      remoteEnvironmentLabels: isRemote ? [member.environmentLabel ?? input.environmentLabel] : [],
      memberProjects: [member],
      memberProjectRefs: [scopeProjectRef(member.environmentId, member.id)],
    };
    return [
      {
        id: member.id,
        sidebarProjectKey: sectionSidebarProjectKey(member.environmentId, member.id),
        project,
        sectionId,
      },
    ];
  });
}

function mapNode(
  environmentId: EnvironmentId,
  node: SectionTreeNode<OrchestrationProjectShell>,
  groupByProjectId: ReadonlyMap<string, SidebarProjectSnapshot>,
  input: SectionSidebarRowInput,
): SectionTreeNode<SectionSidebarProject> {
  return {
    section: node.section,
    childSections: node.childSections.map((child) =>
      mapNode(environmentId, child, groupByProjectId, input),
    ),
    projects: groupedRows(environmentId, node.projects, node.section.id, groupByProjectId, input),
  };
}

export function buildSectionSidebarEnvironment(input: {
  environmentId: EnvironmentId;
  label: string;
  primaryEnvironmentId: EnvironmentId | null;
  isDesktopLocalEnvironment: boolean;
  isWslEnvironment: boolean;
  projects: ReadonlyArray<OrchestrationProjectShell>;
  projectGroups: ReadonlyArray<SidebarProjectSnapshot>;
  serverView: EnvironmentSectionsView | undefined;
}): SectionSidebarEnvironment {
  const projectGroupsById = new Map<string, SidebarProjectSnapshot>();
  for (const group of input.projectGroups) {
    for (const member of group.memberProjects) {
      projectGroupsById.set(
        scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
        group,
      );
    }
  }

  const rowInput = {
    primaryEnvironmentId: input.primaryEnvironmentId,
    isDesktopLocalEnvironment: input.isDesktopLocalEnvironment,
    isWslEnvironment: input.isWslEnvironment,
    environmentLabel: input.label,
  };
  const sourceTree =
    input.serverView?.tree ??
    ({
      roots: [],
      rootProjects: [],
      unplacedProjects: input.projects,
    } satisfies SectionTree<OrchestrationProjectShell>);
  const unplacedIds = new Set(sourceTree.unplacedProjects.map((project) => project.id));
  const orderedProjects = [
    ...sourceTree.unplacedProjects,
    ...input.projects.filter((project) => !unplacedIds.has(project.id)),
  ];

  const tree: SectionTree<SectionSidebarProject> = {
    roots: sourceTree.roots.map((node) =>
      mapNode(input.environmentId, node, projectGroupsById, rowInput),
    ),
    rootProjects: groupedRows(
      input.environmentId,
      sourceTree.rootProjects,
      null,
      projectGroupsById,
      rowInput,
    ),
    unplacedProjects: groupedRows(
      input.environmentId,
      sourceTree.unplacedProjects,
      null,
      projectGroupsById,
      rowInput,
    ),
  };

  return {
    environmentId: input.environmentId,
    label: input.label,
    snapshot: input.serverView?.snapshot ?? null,
    orderedProjects,
    tree,
  };
}

function sectionSidebarProjectKey(environmentId: EnvironmentId, projectId: ProjectId): string {
  return `section-project:${scopedProjectKey(scopeProjectRef(environmentId, projectId))}`;
}
