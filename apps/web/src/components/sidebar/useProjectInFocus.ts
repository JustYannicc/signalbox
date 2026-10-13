/**
 * Whether a real project is in sight under Focus, for surfaces outside the
 * Home tree (New bar suggestions). Uses the Home tree's placement: the user's
 * section override, else the name heuristic.
 */
import { useCallback } from "react";

import { isSectionInFocus, projectSectionId } from "./focus/focusLevels";
import { useFocusedLevel } from "./focus/focusStore";
import { useHomeSectionStore } from "./sections/sectionStore";

export interface FocusProject {
  readonly environmentId: string;
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

export function useProjectInFocus(): (project: FocusProject) => boolean {
  const focused = useFocusedLevel();
  const overrides = useHomeSectionStore((state) => state.projectSectionOverrides);
  return useCallback(
    (project) =>
      isSectionInFocus(
        projectSectionId(
          {
            projectKey: `${project.environmentId}:${project.id}`,
            displayName: project.title,
            workspaceRoot: project.workspaceRoot,
          },
          overrides,
        ),
        focused,
      ),
    [focused, overrides],
  );
}
