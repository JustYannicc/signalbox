import type { ProjectId } from "@t3tools/contracts";
import type {
  ProjectSectionPlacement,
  Section,
  SectionId,
  SectionsSnapshot,
} from "@t3tools/contracts/sections";

export interface SectionTreeNode<Project> {
  readonly section: Section;
  readonly childSections: ReadonlyArray<SectionTreeNode<Project>>;
  readonly projects: ReadonlyArray<Project>;
}

/** Projects with no placement stay visible while an older server has no sections. */
export interface SectionTree<Project> {
  readonly roots: ReadonlyArray<SectionTreeNode<Project>>;
  readonly rootProjects: ReadonlyArray<Project>;
  readonly unplacedProjects: ReadonlyArray<Project>;
}

export interface SectionDestination {
  readonly section: Section;
  /** Sections from the root down to this section's parent. */
  readonly ancestors: ReadonlyArray<Section>;
  readonly ancestorIds: ReadonlySet<SectionId>;
}

const EMPTY_SECTION_TREE: SectionTree<never> = Object.freeze({
  roots: Object.freeze([]),
  rootProjects: Object.freeze([]),
  unplacedProjects: Object.freeze([]),
});

/** A reconnect may replay a snapshot that predates one already shown locally. */
function applySectionsSnapshot(
  current: SectionsSnapshot | null,
  incoming: SectionsSnapshot,
): SectionsSnapshot {
  return current !== null && incoming.revision <= current.revision ? current : incoming;
}

export interface SessionSectionsSnapshot<TSession extends object> {
  readonly session: TSession | null;
  readonly snapshot: SectionsSnapshot | null;
}

/** Revisions are monotonic within a session; a new server session is authoritative. */
export function applySectionsSnapshotForSession<TSession extends object>(
  current: SessionSectionsSnapshot<TSession>,
  activeSession: TSession | null,
  session: TSession,
  incoming: SectionsSnapshot,
): SessionSectionsSnapshot<TSession> {
  if (session !== activeSession) return current;
  if (current.session !== session) return { session, snapshot: incoming };
  const snapshot = applySectionsSnapshot(current.snapshot, incoming);
  return snapshot === current.snapshot ? current : { session, snapshot };
}

/** Builds the shared ordered section tree and keeps legacy projects unplaced. */
export function sectionTreeFromSnapshot<Project extends { readonly id: ProjectId }>(
  snapshot: SectionsSnapshot | null,
  projects: ReadonlyArray<Project>,
): SectionTree<Project> {
  if (snapshot === null) {
    return { ...EMPTY_SECTION_TREE, unplacedProjects: projects };
  }

  const placementsByProject = new Map(
    snapshot.projectPlacements.map((placement) => [placement.projectId, placement] as const),
  );
  const sectionsById = new Map(snapshot.sections.map((section) => [section.id, section] as const));
  const childrenByParent = new Map<string | null, Section[]>();
  for (const section of snapshot.sections) {
    const siblings = childrenByParent.get(section.parentId) ?? [];
    siblings.push(section);
    childrenByParent.set(section.parentId, siblings);
  }
  for (const siblings of childrenByParent.values()) siblings.sort(compareSectionPosition);

  const projectRowsBySection = new Map<string, ProjectSectionPlacement[]>();
  const rootRows: ProjectSectionPlacement[] = [];
  for (const placement of snapshot.projectPlacements) {
    if (placement.sectionId === null) {
      rootRows.push(placement);
    } else if (sectionsById.has(placement.sectionId)) {
      const rows = projectRowsBySection.get(placement.sectionId) ?? [];
      rows.push(placement);
      projectRowsBySection.set(placement.sectionId, rows);
    }
  }
  for (const rows of projectRowsBySection.values()) rows.sort(comparePlacementPosition);
  rootRows.sort(comparePlacementPosition);

  const projectsById = new Map(projects.map((project) => [project.id, project] as const));
  const unplacedProjects: Project[] = [];
  for (const project of projects) {
    const placement = placementsByProject.get(project.id);
    if (
      placement === undefined ||
      (placement.sectionId !== null && !sectionsById.has(placement.sectionId))
    ) {
      unplacedProjects.push(project);
    }
  }

  const buildNode = (
    section: Section,
    ancestors: ReadonlySet<string>,
  ): SectionTreeNode<Project> => {
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(section.id);
    const childSections = (childrenByParent.get(section.id) ?? [])
      .filter((child) => !nextAncestors.has(child.id))
      .map((child) => buildNode(child, nextAncestors));
    const sectionProjects = (projectRowsBySection.get(section.id) ?? []).flatMap((placement) => {
      const project = projectsById.get(placement.projectId);
      return project === undefined ? [] : [project];
    });
    return { section, childSections, projects: sectionProjects };
  };

  const roots = (childrenByParent.get(null) ?? []).map((section) => buildNode(section, new Set()));
  const rootProjects = rootRows.flatMap((placement) => {
    const project = projectsById.get(placement.projectId);
    return project === undefined ? [] : [project];
  });
  return { roots, rootProjects, unplacedProjects };
}

function compareSectionPosition(left: Section, right: Section) {
  return left.position - right.position || left.id.localeCompare(right.id);
}

function comparePlacementPosition(left: ProjectSectionPlacement, right: ProjectSectionPlacement) {
  return left.position - right.position || left.projectId.localeCompare(right.projectId);
}
