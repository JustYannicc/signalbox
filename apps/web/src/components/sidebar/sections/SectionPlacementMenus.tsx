import {
  projectSiblingMoveInput,
  sectionMoveDestinations,
  sectionSiblingMoveInput,
} from "@t3tools/client-runtime/state/sections";
import type { ProjectId } from "@t3tools/contracts";
import type { Section, SectionsSnapshot } from "@t3tools/contracts/sections";
import {
  EllipsisIcon,
  FolderInputIcon,
  FolderPlusIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";

import { Button } from "../../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../ui/menu";
import {
  contextIdOfProject,
  projectSectionDestinations,
  projectsInContextOf,
} from "@t3tools/client-runtime/state/signalboxContexts"; // signalbox: contexts
import { useSectionSidebarActions } from "./SectionSidebarActions";
import type { SectionSidebarEnvironment, SectionSidebarProject } from "./sectionProjectTree";

export function SectionMoveMenu(props: {
  environmentId: SectionSidebarEnvironment["environmentId"];
  snapshot: SectionsSnapshot;
  section: Section;
  siblings: ReadonlyArray<Section>;
}) {
  const actions = useSectionSidebarActions();
  const destinations = sectionMoveDestinations(props.snapshot, props.section.id);
  const currentIndex = props.siblings.findIndex((sibling) => sibling.id === props.section.id);
  const parent = props.section.parentId
    ? props.snapshot.sections.find((section) => section.id === props.section.parentId)
    : undefined;

  const moveOrder = (direction: "up" | "down") => {
    const input = sectionSiblingMoveInput({
      sectionId: props.section.id,
      direction,
      snapshot: props.snapshot,
    });
    if (input) void actions.moveSection(props.environmentId, input);
  };

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`More for ${props.section.name}`}
          />
        }
      >
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end" side="right">
        <MenuItem onClick={() => actions.openCreate(props.environmentId, props.section.id)}>
          <FolderPlusIcon />
          New subsection
        </MenuItem>
        <MenuItem onClick={() => actions.openRename(props.environmentId, props.section)}>
          <PencilIcon />
          Rename
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger>
            <FolderInputIcon />
            Move to…
          </MenuSubTrigger>
          <MenuSubPopup>
            <MenuItem
              disabled={props.section.parentId === null}
              onClick={() =>
                void actions.moveSection(props.environmentId, {
                  id: props.section.id,
                  parentId: null,
                })
              }
            >
              Top level
            </MenuItem>
            {destinations.map((destination) => (
              <MenuItem
                key={destination.section.id}
                onClick={() =>
                  void actions.moveSection(props.environmentId, {
                    id: props.section.id,
                    parentId: destination.section.id,
                  })
                }
              >
                {[...destination.ancestors, destination.section]
                  .map((section) => section.name)
                  .join(" › ")}
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        <MenuItem disabled={currentIndex <= 0} onClick={() => moveOrder("up")}>
          Move up
        </MenuItem>
        <MenuItem
          disabled={currentIndex < 0 || currentIndex >= props.siblings.length - 1}
          onClick={() => moveOrder("down")}
        >
          Move down
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          variant="destructive"
          onClick={() =>
            actions.openDelete(props.environmentId, props.section, parent?.name ?? null)
          }
        >
          <Trash2Icon />
          Delete section
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

export function ProjectPlacementMenu(props: {
  environment: SectionSidebarEnvironment;
  project: SectionSidebarProject;
  sectionId: string | null;
  siblingProjectIds: ReadonlyArray<ProjectId>;
}) {
  const actions = useSectionSidebarActions();
  const snapshot = props.environment.snapshot;
  const index = props.siblingProjectIds.indexOf(props.project.id);
  if (!snapshot) return null;
  // signalbox: a project stays in its context's sections (both absent outside the cloud).
  const contexts = props.environment.contexts ?? null;
  const destinations = projectSectionDestinations(
    snapshot,
    contextIdOfProject(contexts, props.project.id),
  );

  const moveOrder = (direction: "up" | "down") => {
    const input = projectSiblingMoveInput({
      projectId: props.project.id,
      direction,
      snapshot,
      // signalbox: reorder among the project's own context only.
      projects: projectsInContextOf(contexts, props.project.id, props.environment.orderedProjects),
    });
    if (input) void actions.moveProject(props.environment.environmentId, input);
  };

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Move ${props.project.project.displayName}`}
          />
        }
      >
        <FolderInputIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" side="right">
        <MenuSub>
          <MenuSubTrigger>
            <FolderInputIcon />
            Move to…
          </MenuSubTrigger>
          <MenuSubPopup>
            <MenuItem
              disabled={props.sectionId === null}
              onClick={() =>
                void actions.moveProject(props.environment.environmentId, {
                  projectId: props.project.id,
                  sectionId: null,
                })
              }
            >
              Top level
            </MenuItem>
            {destinations
              .filter((destination) => destination.section.id !== props.sectionId)
              .map((destination) => (
                <MenuItem
                  key={destination.section.id}
                  onClick={() =>
                    void actions.moveProject(props.environment.environmentId, {
                      projectId: props.project.id,
                      sectionId: destination.section.id,
                    })
                  }
                >
                  {[...destination.ancestors, destination.section]
                    .map((section) => section.name)
                    .join(" › ")}
                </MenuItem>
              ))}
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        <MenuItem disabled={index <= 0} onClick={() => moveOrder("up")}>
          Move up
        </MenuItem>
        <MenuItem
          disabled={index < 0 || index >= props.siblingProjectIds.length - 1}
          onClick={() => moveOrder("down")}
        >
          Move down
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
