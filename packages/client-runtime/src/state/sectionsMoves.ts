import type { ProjectId } from "@t3tools/contracts";
import type {
  ProjectSectionPlacement,
  Section,
  SectionId,
  SectionMoveInput,
  SectionProjectMoveInput,
  SectionsSnapshot,
} from "@t3tools/contracts/sections";

import type { SectionDestination } from "./sectionsModel.ts";

function compareSectionPosition(left: Section, right: Section) {
  return left.position - right.position || left.id.localeCompare(right.id);
}

function comparePlacementPosition(left: ProjectSectionPlacement, right: ProjectSectionPlacement) {
  return left.position - right.position || left.projectId.localeCompare(right.projectId);
}

/** Flattens valid section destinations in their displayed tree order. */
export function sectionDestinations(snapshot: SectionsSnapshot): ReadonlyArray<SectionDestination> {
  const childrenByParent = new Map<SectionId | null, Section[]>();
  for (const section of snapshot.sections) {
    const children = childrenByParent.get(section.parentId) ?? [];
    children.push(section);
    childrenByParent.set(section.parentId, children);
  }
  for (const children of childrenByParent.values()) children.sort(compareSectionPosition);

  const destinations: SectionDestination[] = [];
  const visit = (
    section: Section,
    ancestors: ReadonlyArray<Section>,
    ancestorIds: ReadonlySet<SectionId>,
  ) => {
    if (ancestorIds.has(section.id)) return;
    destinations.push({ section, ancestors, ancestorIds });
    const nextAncestors = [...ancestors, section];
    const nextAncestorIds = new Set(ancestorIds).add(section.id);
    for (const child of childrenByParent.get(section.id) ?? []) {
      visit(child, nextAncestors, nextAncestorIds);
    }
  };

  for (const root of childrenByParent.get(null) ?? []) visit(root, [], new Set());
  return destinations;
}

/** Section parents that do not create cycles or leave the section where it is. */
export function sectionMoveDestinations(
  snapshot: SectionsSnapshot,
  sectionId: SectionId,
): ReadonlyArray<SectionDestination> {
  const section = snapshot.sections.find((candidate) => candidate.id === sectionId);
  if (section === undefined) return [];
  return sectionDestinations(snapshot).filter(
    (destination) =>
      destination.section.id !== sectionId &&
      destination.section.id !== section.parentId &&
      !destination.ancestorIds.has(sectionId),
  );
}

export function siblingSectionMove(input: {
  readonly sectionId: SectionId;
  readonly parentId: SectionId | null;
  readonly direction: "up" | "down";
  readonly sections: ReadonlyArray<Section>;
}): { readonly parentId: SectionId | null; readonly beforeId?: SectionId } | null {
  const siblings = input.sections
    .filter((section) => section.parentId === input.parentId)
    .slice()
    .sort(compareSectionPosition);
  const index = siblings.findIndex((section) => section.id === input.sectionId);
  if (index < 0) return null;

  if (input.direction === "up") {
    if (index === 0) return null;
    return { parentId: input.parentId, beforeId: siblings[index - 1]!.id };
  }
  if (index >= siblings.length - 1) return null;
  const afterNext = siblings[index + 2];
  return afterNext === undefined
    ? { parentId: input.parentId }
    : { parentId: input.parentId, beforeId: afterNext.id };
}

export function siblingProjectMove(input: {
  readonly projectId: ProjectId;
  readonly sectionId: SectionId | null;
  readonly direction: "up" | "down";
  readonly snapshot: SectionsSnapshot;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId }>;
}): { readonly sectionId: SectionId | null; readonly beforeProjectId?: ProjectId } | null {
  const knownProjectIds = new Set(input.projects.map((project) => project.id));
  const explicitSiblings = input.snapshot.projectPlacements
    .filter((placement) => placement.sectionId === input.sectionId)
    .filter((placement) => knownProjectIds.has(placement.projectId))
    .slice()
    .sort(comparePlacementPosition)
    .map((placement) => placement.projectId);
  const siblingIds =
    input.sectionId !== null
      ? explicitSiblings
      : [
          ...explicitSiblings,
          ...input.projects
            .map((project) => project.id)
            .filter(
              (projectId) =>
                !input.snapshot.projectPlacements.some(
                  (placement) => placement.projectId === projectId,
                ),
            ),
        ];
  const index = siblingIds.findIndex((projectId) => projectId === input.projectId);
  if (index < 0) return null;

  if (input.direction === "up") {
    if (index === 0) return null;
    return { sectionId: input.sectionId, beforeProjectId: siblingIds[index - 1]! };
  }
  if (index >= siblingIds.length - 1) return null;
  const afterNext = siblingIds[index + 2];
  return afterNext === undefined
    ? { sectionId: input.sectionId }
    : { sectionId: input.sectionId, beforeProjectId: afterNext };
}

export function sectionSiblingMoveInput(input: {
  readonly sectionId: SectionId;
  readonly direction: "up" | "down";
  readonly snapshot: SectionsSnapshot;
}): SectionMoveInput | null {
  const section = input.snapshot.sections.find((candidate) => candidate.id === input.sectionId);
  if (section === undefined) return null;
  const move = siblingSectionMove({
    sectionId: section.id,
    parentId: section.parentId,
    direction: input.direction,
    sections: input.snapshot.sections,
  });
  return move === null ? null : { id: section.id, ...move };
}

export function projectSiblingMoveInput(input: {
  readonly projectId: ProjectId;
  readonly direction: "up" | "down";
  readonly snapshot: SectionsSnapshot;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId }>;
}): SectionProjectMoveInput | null {
  const placement = input.snapshot.projectPlacements.find(
    (candidate) => candidate.projectId === input.projectId,
  );
  if (
    placement === undefined &&
    !input.projects.some((project) => project.id === input.projectId)
  ) {
    return null;
  }
  const move = siblingProjectMove({
    projectId: input.projectId,
    sectionId: placement?.sectionId ?? null,
    direction: input.direction,
    snapshot: input.snapshot,
    projects: input.projects,
  });
  return move === null ? null : { projectId: input.projectId, ...move };
}
