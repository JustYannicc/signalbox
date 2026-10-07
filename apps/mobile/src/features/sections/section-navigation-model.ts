import {
  projectSiblingMoveInput,
  sectionDestinations,
  sectionMoveDestinations,
  sectionSiblingMoveInput,
} from "@t3tools/client-runtime/state/sections";
import type { Section, SectionId, SectionsSnapshot } from "@t3tools/contracts/sections";
import type { MenuAction } from "@react-native-menu/menu";
import { projectSectionDestinations } from "@t3tools/client-runtime/state/signalboxContexts"; // signalbox: contexts

export { projectSiblingMoveInput, sectionSiblingMoveInput };

function sectionPath(destination: ReturnType<typeof sectionDestinations>[number]): string {
  return [...destination.ancestors.map((section) => section.name), destination.section.name].join(
    " / ",
  );
}

export function projectMoveMenuActions(input: {
  readonly snapshot: SectionsSnapshot;
  readonly sectionId: SectionId | null;
  readonly siblingIndex: number;
  readonly siblingCount: number;
  /** signalbox: a top-level project's cloud context; inside a section, the section's. */
  readonly contextId?: string;
}): MenuAction[] {
  const contextId =
    input.contextId ??
    input.snapshot.sections.find((section) => section.id === input.sectionId)?.contextId;
  const destinations: MenuAction[] = [
    {
      id: "project:root",
      title: "Top level",
      state: input.sectionId === null ? "on" : undefined,
    },
    ...projectSectionDestinations(input.snapshot, contextId).map((destination) => ({
      id: `project:section:${destination.section.id}`,
      title: sectionPath(destination),
      state: input.sectionId === destination.section.id ? ("on" as const) : undefined,
    })),
  ];
  const actions: MenuAction[] = [
    { id: "project:move", title: "Move to", subactions: destinations },
  ];
  if (input.siblingIndex > 0) {
    actions.push({ id: "project:up", title: "Move up" });
  }
  if (input.siblingIndex < input.siblingCount - 1) {
    actions.push({ id: "project:down", title: "Move down" });
  }
  return actions;
}

export function sectionMenuActions(input: {
  readonly section: Section;
  readonly snapshot: SectionsSnapshot;
  /** signalbox: pools new threads in the section can default to. */
  readonly pools?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
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
  const pools = input.pools ?? [];
  if (pools.length > 1) {
    actions.push({
      id: "section:pool",
      title: "Pool for new threads",
      subactions: [
        {
          id: "section:pool:inherit",
          title: section.parentId === null ? "Default" : "Same as parent section",
          state: section.defaultPoolId === undefined ? "on" : undefined,
        },
        ...pools.map((pool) => ({
          id: `section:pool:${pool.id}`,
          title: pool.name,
          state: section.defaultPoolId === pool.id ? ("on" as const) : undefined,
        })),
      ],
    });
  }
  actions.push({
    id: "section:delete",
    title: "Delete section",
    attributes: { destructive: true },
  });
  return actions;
}
