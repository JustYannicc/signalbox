import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { Section, SectionId, SectionsSnapshot } from "@t3tools/contracts/sections";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback } from "react";
import { Alert } from "react-native";
import { projectsInContextOf } from "@t3tools/client-runtime/state/signalboxContexts"; // signalbox: contexts
import type { SignalboxContextsSnapshot } from "@t3tools/contracts/signalboxContexts"; // signalbox: contexts

import { showConfirmDialog, showTextInputDialog } from "../../components/ConfirmDialogHost";
import { environmentSections } from "../../state/sections";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectSiblingMoveInput, sectionSiblingMoveInput } from "./section-navigation-model";

export function useSectionActions(input: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: SectionsSnapshot | null;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId }>;
  /** signalbox: Signalbox Cloud's contexts; projects reorder within their own. */
  readonly contexts?: SignalboxContextsSnapshot | null;
}) {
  const { environmentId, snapshot, projects, contexts } = input;
  const createSection = useAtomCommand(environmentSections.createSection, {
    reportFailure: false,
  });
  const updateSection = useAtomCommand(environmentSections.updateSection, {
    reportFailure: false,
  });
  const moveSection = useAtomCommand(environmentSections.moveSection, {
    reportFailure: false,
  });
  const deleteSection = useAtomCommand(environmentSections.deleteSection, {
    reportFailure: false,
  });
  const moveProject = useAtomCommand(environmentSections.moveProject, {
    reportFailure: false,
  });

  const reportFailure = useCallback((title: string, detail: string, error: unknown) => {
    Alert.alert(title, error instanceof Error && error.message.trim() ? error.message : detail);
  }, []);
  const run = useCallback(
    async <A, E>(title: string, detail: string, operation: Promise<AtomCommandResult<A, E>>) => {
      const result = await operation;
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportFailure(title, detail, squashAtomCommandFailure(result));
        }
        return false;
      }
      return result._tag === "Success";
    },
    [reportFailure],
  );

  const requestCreateSection = useCallback(
    (parentId: SectionId | null, contextId?: string) => {
      showTextInputDialog({
        title: parentId === null ? "New section" : "New nested section",
        initialValue: "",
        confirmText: "Create",
        onConfirm: (name) => {
          void run(
            "Could not create section",
            "The section could not be created.",
            createSection({
              environmentId,
              // signalbox: the cloud context a top-level section organizes.
              input: { name, parentId, ...(contextId === undefined ? {} : { contextId }) },
            }),
          );
        },
      });
    },
    [createSection, environmentId, run],
  );

  const onProjectAction = useCallback(
    (projectId: ProjectId, event: string) => {
      if (snapshot === null) return;
      const placement = snapshot.projectPlacements.find(
        (candidate) => candidate.projectId === projectId,
      );
      const sectionId = event.startsWith("project:section:")
        ? (snapshot.sections.find(
            (section) => section.id === event.slice("project:section:".length),
          )?.id ?? null)
        : null;
      if (event === "project:move") return;
      if (event === "project:up" || event === "project:down") {
        const input = projectSiblingMoveInput({
          projectId,
          direction: event === "project:up" ? "up" : "down",
          snapshot,
          projects: projectsInContextOf(contexts ?? null, projectId, projects),
        });
        if (input !== null) {
          void run(
            "Could not reorder project",
            "The project could not be reordered.",
            moveProject({ environmentId, input }),
          );
        }
        return;
      }
      if (event !== "project:root" && (!event.startsWith("project:section:") || sectionId === null))
        return;
      if (placement?.sectionId === sectionId && placement !== undefined) return;
      void run(
        "Could not move project",
        "The project could not be moved.",
        moveProject({ environmentId, input: { projectId, sectionId } }),
      );
    },
    [contexts, environmentId, moveProject, projects, run, snapshot],
  );

  const onSectionAction = useCallback(
    (section: Section, event: string) => {
      if (snapshot === null) return;
      if (event === "section:add-child") {
        requestCreateSection(section.id);
        return;
      }
      if (event === "section:rename") {
        showTextInputDialog({
          title: "Rename section",
          initialValue: section.name,
          confirmText: "Save",
          onConfirm: (name) => {
            if (name.trim() === section.name) return;
            void run(
              "Could not rename section",
              "The section could not be renamed.",
              updateSection({ environmentId, input: { id: section.id, name } }),
            );
          },
        });
        return;
      }
      if (event === "section:delete") {
        showConfirmDialog({
          title: "Delete section?",
          message:
            "Child sections and projects move up to this section's parent. Threads and files stay in place.",
          confirmText: "Delete",
          destructive: true,
          onConfirm: () => {
            void run(
              "Could not delete section",
              "The section could not be deleted.",
              deleteSection({ environmentId, input: { id: section.id } }),
            );
          },
        });
        return;
      }
      if (event === "section:up" || event === "section:down") {
        const input = sectionSiblingMoveInput({
          sectionId: section.id,
          direction: event === "section:up" ? "up" : "down",
          snapshot,
        });
        if (input !== null) {
          void run(
            "Could not reorder section",
            "The section could not be reordered.",
            moveSection({ environmentId, input }),
          );
        }
        return;
      }
      if (event === "section:parent:root") {
        void run(
          "Could not move section",
          "The section could not be moved.",
          moveSection({ environmentId, input: { id: section.id, parentId: null } }),
        );
        return;
      }
      if (event.startsWith("section:parent:")) {
        const parentId = snapshot.sections.find(
          (candidate) => candidate.id === event.slice("section:parent:".length),
        )?.id;
        if (parentId === undefined) return;
        void run(
          "Could not move section",
          "The section could not be moved.",
          moveSection({ environmentId, input: { id: section.id, parentId } }),
        );
      }
    },
    [deleteSection, environmentId, moveSection, requestCreateSection, run, snapshot, updateSection],
  );

  return { requestCreateSection, onProjectAction, onSectionAction };
}
