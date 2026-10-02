/**
 * Whether a real project is in sight under the current Focus mode, for
 * surfaces outside the Home tree (the Pipeline rail badge, New bar
 * suggestions). Mirrors the Home tree's placement: the user's section
 * override, else the name heuristic.
 *
 * TODO: switch to `isInFocus` from `focus/focusStore.ts` once it lands, so
 * placement lives in one place.
 */
import { useCallback } from "react";

import { useFocusStore, focusModeInfo } from "./focus/focusStore";
import {
  defaultSectionIdForProject,
  findHomeSection,
  rootSectionIdOf,
} from "./sections/sectionModel";
import { useHomeSectionStore } from "./sections/sectionStore";

export interface FocusProject {
  readonly environmentId: string;
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

export function useProjectInFocus(): (project: FocusProject) => boolean {
  const mode = useFocusStore((state) => state.mode);
  const overrides = useHomeSectionStore((state) => state.projectSectionOverrides);
  return useCallback(
    (project) => {
      const hidden = focusModeInfo(mode).hiddenRootSectionIds;
      if (hidden.length === 0) return true;
      const override = overrides[`${project.environmentId}:${project.id}`];
      const sectionId =
        override && findHomeSection(override)
          ? override
          : defaultSectionIdForProject({
              displayName: project.title,
              workspaceRoot: project.workspaceRoot,
            });
      return !hidden.includes(rootSectionIdOf(sectionId));
    },
    [mode, overrides],
  );
}
