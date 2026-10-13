/**
 * Focus as a view over levels: you focus a level (the top level means All) and
 * only that subtree, plus the levels above it, stays in sight. Everything else
 * is out of sight and out of mind: no rows, no counts, no "still running".
 * Hidden work keeps running, and access never reads any of this (`levels.ts`
 * decides what agents can use, whatever Focus says).
 *
 * Surfaces ask `isInSight` for anything that would draw attention (a badge,
 * a count, a suggestion). `isSectionInFocus` / `hiddenRootSectionIds` serve
 * the Home tree, Spaces and the New bar.
 */
import { escalates } from "../../levels/escalation";
import { levelChain, TOP_LEVEL, type LevelKey } from "../../levels/levels";
import type { ThreadDisplayStatus } from "../../threadStatusDisplay";
import type { ProjectRef } from "../sections/mappedItems";
import {
  childSectionsOf,
  defaultSectionIdForProject,
  findHomeSection,
} from "../sections/sectionModel";
import { useHomeSectionStore } from "../sections/sectionStore";

type Placement = Pick<ReturnType<typeof useHomeSectionStore.getState>, "projectSectionOverrides">;

/** Section, project and team project keys sit in a subtree; anything else hangs off the top. */
function sitsInSubtree(level: LevelKey): boolean {
  return (
    level.startsWith("section:") ||
    level.startsWith("project:") ||
    level.startsWith("team-project:")
  );
}

/** The focused level, or the top level when it names a section that's gone. */
export function liveFocusedLevel(focused: LevelKey): LevelKey {
  if (focused.startsWith("section:") && !findHomeSection(focused.slice(8))) return TOP_LEVEL;
  return focused;
}

/**
 * Whether a level is in sight: inside the focused subtree, or above it (the
 * levels you're standing under, like the top level's own chats).
 */
export function isLevelInFocus(
  level: LevelKey,
  focused: LevelKey,
  placement: Placement = useHomeSectionStore.getState(),
): boolean {
  const focus = liveFocusedLevel(focused);
  if (focus === TOP_LEVEL || !sitsInSubtree(level)) return true;
  return (
    levelChain(level, placement).includes(focus) || levelChain(focus, placement).includes(level)
  );
}

/** `null` is the top level. */
export function isSectionInFocus(sectionId: string | null, focused: LevelKey): boolean {
  return sectionId === null || isLevelInFocus(`section:${sectionId}`, focused);
}

/** Root sections Focus keeps out of sight, for the tree and "Work hidden". */
export function hiddenRootSectionIds(focused: LevelKey): readonly string[] {
  return childSectionsOf(null)
    .filter((section) => !isSectionInFocus(section.id, focused))
    .map((section) => section.id);
}

/** Something that could draw attention: the levels it sits at (empty = the top level). */
export interface FocusSubject {
  readonly levels: readonly LevelKey[];
  /** What it wants from you; escalation rules match on it. */
  readonly status?: ThreadDisplayStatus | null;
}

/**
 * Escalation: a rule at a level (Settings › Notifications › Breaks through
 * Focus, `levels/escalation.ts`) lets matching statuses show through Focus.
 * Every attention surface goes through `isInSight`, so rules land in one place.
 */
export function breaksThroughFocus(subject: FocusSubject, focused: LevelKey): boolean {
  return escalates({ levels: subject.levels, status: subject.status ?? null }, focused);
}

/** Whether a subject may draw attention: any of its levels is in focus, or it breaks through. */
export function isInSight(
  subject: FocusSubject,
  focused: LevelKey,
  placement?: Placement,
): boolean {
  if (subject.levels.length === 0) return true;
  return (
    subject.levels.some((level) => isLevelInFocus(level, focused, placement)) ||
    breaksThroughFocus(subject, focused)
  );
}

/** The section a real project sits in, as the Home tree places it: your move, else the name heuristic. */
export function projectSectionId(
  project: ProjectRef,
  overrides: Placement["projectSectionOverrides"],
): string {
  const override = overrides[project.projectKey];
  return override && findHomeSection(override) ? override : defaultSectionIdForProject(project);
}

/**
 * The level Focus judges a Home container key by. Real projects resolve to
 * their section here, because `levels.ts` only learns their default section
 * once the Home tree renders.
 */
export function focusLevelOf(
  key: string,
  projects: ReadonlyMap<string, ProjectRef>,
  overrides: Placement["projectSectionOverrides"],
): LevelKey {
  if (!key.startsWith("project:")) return key;
  const project = projects.get(key.slice(8));
  return project ? `section:${projectSectionId(project, overrides)}` : key;
}

/** "All" for the top level, else the section's name. */
export function focusLabel(focused: LevelKey): string {
  const focus = liveFocusedLevel(focused);
  if (focus === TOP_LEVEL) return "All";
  return (focus.startsWith("section:") && findHomeSection(focus.slice(8))?.name) || focus;
}
