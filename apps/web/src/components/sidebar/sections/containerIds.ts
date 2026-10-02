/**
 * The multiplayer container a Home item belongs to, honoring the user's moves:
 * a Home section id, a team project id, or `"home"` for the top level. Both
 * the sidebar's scope marker and the thread top bar's access should read this
 * so they never disagree.
 */
import { useHomeSectionStore } from "./sectionStore";
import { defaultSectionIdForProject } from "./sectionModel";

export const HOME_TOP_LEVEL_ID = "home";

export interface ThreadContainerInput {
  /** `homeThreadKey(thread)` for real threads, the fixture id otherwise. */
  readonly threadKey: string;
  /** The thread's own project, for real threads. */
  readonly project: {
    readonly projectKey: string;
    readonly displayName: string;
    readonly workspaceRoot: string;
  } | null;
}

type Placement = Pick<
  ReturnType<typeof useHomeSectionStore.getState>,
  "itemContainers" | "projectSectionOverrides"
>;

function sectionOfProject(projectKey: string, placement: Placement, fallback: string): string {
  return placement.projectSectionOverrides[projectKey] ?? fallback;
}

/** Resolves a Home container key (`section:…`, `team-project:…`, `project:…`, `root`). */
export function containerIdForKey(
  containerKey: string,
  placement: Placement = useHomeSectionStore.getState(),
): string {
  if (containerKey.startsWith("section:")) return containerKey.slice(8);
  if (containerKey.startsWith("team-project:")) return containerKey.slice(13);
  if (containerKey.startsWith("project:")) {
    return sectionOfProject(containerKey.slice(8), placement, "personal");
  }
  return HOME_TOP_LEVEL_ID;
}

export function containerIdForThread(
  input: ThreadContainerInput,
  placement: Placement = useHomeSectionStore.getState(),
): string {
  const moved = placement.itemContainers[input.threadKey];
  if (moved) return containerIdForKey(moved, placement);
  if (!input.project) return HOME_TOP_LEVEL_ID;
  return sectionOfProject(
    input.project.projectKey,
    placement,
    defaultSectionIdForProject(input.project),
  );
}

/** Reactive `containerIdForThread`. */
export function useContainerIdForThread(input: ThreadContainerInput): string {
  const itemContainers = useHomeSectionStore((state) => state.itemContainers);
  const projectSectionOverrides = useHomeSectionStore((state) => state.projectSectionOverrides);
  return containerIdForThread(input, { itemContainers, projectSectionOverrides });
}
