import {
  projectSiblingMoveInput,
  sectionDestinations,
  sectionMoveDestinations,
  sectionSiblingMoveInput,
} from "@t3tools/client-runtime/state/sections";
import type { ProjectId } from "@t3tools/contracts";
import type { Section, SectionsSnapshot } from "@t3tools/contracts/sections";
import type { MenuAction } from "@react-native-menu/menu";

export { projectSiblingMoveInput, sectionSiblingMoveInput };

function sectionPath(destination: ReturnType<typeof sectionDestinations>[number]): string {
  return [...destination.ancestors.map((section) => section.name), destination.section.name].join(
    " / ",
  );
}

export function projectMoveMenuActions(input: {
  readonly snapshot: SectionsSnapshot;
  readonly projectId: ProjectId;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId }>;
}): MenuAction[] {
  const currentPlacement = input.snapshot.projectPlacements.find(
    (placement) => placement.projectId === input.projectId,
  );
  const currentSectionId = currentPlacement?.sectionId ?? null;
  const destinations: MenuAction[] = [
    {
      id: "project:root",
      title: "Top level",
      state: currentPlacement !== undefined && currentSectionId === null ? "on" : undefined,
    },
    ...sectionDestinations(input.snapshot).map((destination) => ({
      id: `project:section:${destination.section.id}`,
      title: sectionPath(destination),
      state: currentSectionId === destination.section.id ? ("on" as const) : undefined,
    })),
  ];
  const actions: MenuAction[] = [
    { id: "project:move", title: "Move to", subactions: destinations },
  ];
  if (
    projectSiblingMoveInput({
      projectId: input.projectId,
      direction: "up",
      snapshot: input.snapshot,
      projects: input.projects,
    }) !== null
  ) {
    actions.push({ id: "project:up", title: "Move up" });
  }
  if (
    projectSiblingMoveInput({
      projectId: input.projectId,
      direction: "down",
      snapshot: input.snapshot,
      projects: input.projects,
    }) !== null
  ) {
    actions.push({ id: "project:down", title: "Move down" });
  }
  return actions;
}

export function sectionMenuActions(input: {
  readonly section: Section;
  readonly snapshot: SectionsSnapshot;
}): MenuAction[] {
  const { section, snapshot } = input;
  const parentOptions: MenuAction[] = [];
  if (section.parentId !== null)
    parentOptions.push({ id: "section:parent:root", title: "Top level" });
  for (const destination of sectionMoveDestinations(snapshot, section.id)) {
    parentOptions.push({
      id: `section:parent:${destination.section.id}`,
      title: sectionPath(destination),
    });
  }

  const actions: MenuAction[] = [
    { id: "section:add-child", title: "Add nested section" },
    { id: "section:rename", title: "Rename" },
  ];
  if (sectionSiblingMoveInput({ sectionId: section.id, direction: "up", snapshot }) !== null) {
    actions.push({ id: "section:up", title: "Move up" });
  }
  if (sectionSiblingMoveInput({ sectionId: section.id, direction: "down", snapshot }) !== null) {
    actions.push({ id: "section:down", title: "Move down" });
  }
  if (parentOptions.length > 0) {
    actions.push({ id: "section:move", title: "Move under", subactions: parentOptions });
  }
  actions.push({
    id: "section:delete",
    title: "Delete section",
    attributes: { destructive: true },
  });
  return actions;
}
