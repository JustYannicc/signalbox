/**
 * signalbox: upstream says "project" where Signalbox Cloud keeps folders. Keyed by upstream's
 * text, like `oneEnvironmentCopy.ts`: text this doesn't know, or upstream rewording a string,
 * falls back to upstream's copy rather than breaking.
 */
import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { SignalboxContextsSnapshot } from "@t3tools/contracts/signalboxContexts";

import type { HomeListFilterMenu } from "../home/home-list-filter-menu";

/** Which words fit: upstream's (no folders), folder words, or neutral ones while mixed. */
export type FolderWording = "projects" | "folders" | "mixed";

export function folderWording(input: {
  readonly withFolders: number;
  readonly total: number;
}): FolderWording {
  if (input.withFolders === 0) return "projects";
  return input.withFolders === input.total ? "folders" : "mixed";
}

const FOLDER_COPY: Readonly<Record<string, string>> = {
  Project: "Folder",
  "All projects": "All folders",
  "Show threads from every project": "Show threads from every folder",
  "Filter threads by project": "Filter threads by folder",
  "Choose a project": "Choose a folder",
  "Choose project": "Choose folder",
  "Opens the project picker": "Opens the folder picker",
  "Search projects": "Search folders",
  "No matching projects": "No matching folders",
  "Try a different project name or workspace path.": "Try a different folder name.",
  "Choose another project or create a new task.": "Choose another folder or create a new task.",
};

/** A folder beside a self-hosted project: words that fit both. */
const MIXED_COPY: Readonly<Record<string, string>> = {
  Project: "Location",
  "All projects": "All locations",
  "Show threads from every project": "Show threads from everywhere",
  "Filter threads by project": "Filter threads by location",
  "Choose a project": "Choose where",
  "Choose project": "Choose where",
  "Opens the project picker": "Opens the location picker",
  "Search projects": "Search",
  "No matching projects": "No matches",
  "Try a different project name or workspace path.": "Try a different name or path.",
  "Choose another project or create a new task.": "Choose another location or create a new task.",
};

/** Upstream's share subtitles end in what was shared, so they're matched by their start. */
const SHARE_PREFIX = "Choose a project for ";
const SHARE_PREFIX_COPY: Readonly<Record<Exclude<FolderWording, "projects">, string>> = {
  folders: "Choose a folder for ",
  mixed: "Choose where to put ",
};

export function folderCopy(text: string, wording: FolderWording): string {
  if (wording === "projects") return text;
  const exact = (wording === "folders" ? FOLDER_COPY : MIXED_COPY)[text];
  if (exact !== undefined) return exact;
  return text.startsWith(SHARE_PREFIX)
    ? SHARE_PREFIX_COPY[wording] + text.slice(SHARE_PREFIX.length)
    : text;
}

/** What the picker's "No project" entry says. */
export interface ScratchCopy {
  readonly title: string;
  readonly subtitle: string;
  readonly start: string;
  readonly failed: string;
}

const NO_PROJECT: ScratchCopy = {
  title: "No project",
  subtitle: "Start a task without a project",
  start: "Start without a project",
  failed: "Could not start without a project",
};

/**
 * Nothing in Signalbox Cloud is without a home: starting "without a project" starts at the
 * top of the owner's tree, which the folder tree names after the owner. Null keeps upstream's.
 */
export function scratchCopy(levelName: string | null): ScratchCopy {
  if (levelName === null) return NO_PROJECT;
  return {
    title: levelName,
    subtitle: `Start a task in ${levelName}`,
    start: `Start in ${levelName}`,
    failed: `Could not start in ${levelName}`,
  };
}

/**
 * The owner whose top level a thread without a project starts at: the one that owns the
 * environment's scratch project, else Personal, where the cloud makes it. Null without owners.
 */
export function scratchLevelName(
  owners: SignalboxContextsSnapshot | null | undefined,
  scratchProjectId: ProjectId | null,
): string | null {
  if (!owners) return null;
  const owner =
    (scratchProjectId === null
      ? undefined
      : owners.contexts.find((context) => context.projectIds.includes(scratchProjectId))) ??
    owners.contexts.find((context) => context.kind === "personal");
  return owner?.name ?? null;
}

/**
 * The thread list groups threads without a project as upstream's "No project"; where folders
 * exist they live at their owner's top level, so the group, its rows and its filter entry take
 * the owner's name. Unchanged scopes keep the same array.
 */
export function withScratchScopeTitles<
  Scope extends {
    readonly title: string;
    readonly representative: {
      readonly environmentId: EnvironmentId;
      readonly id: ProjectId;
      readonly isScratch?: true;
    };
  },
>(
  scopes: ReadonlyArray<Scope>,
  ownersFor: (environmentId: EnvironmentId) => SignalboxContextsSnapshot | undefined,
): ReadonlyArray<Scope> {
  let changed = false;
  const renamed = scopes.map((scope) => {
    if (scope.representative.isScratch !== true || scope.title !== NO_PROJECT.title) return scope;
    const name = scratchLevelName(
      ownersFor(scope.representative.environmentId),
      scope.representative.id,
    );
    if (name === null) return scope;
    changed = true;
    return { ...scope, title: name };
  });
  return changed ? renamed : scopes;
}

/** The thread list's filter menu (`buildHomeListFilterMenu`), its project filter reworded. */
export function withFolderFilterMenuCopy(
  menu: HomeListFilterMenu,
  copy: (text: string) => string,
): HomeListFilterMenu {
  return {
    ...menu,
    items: menu.items.map((item) =>
      item.type === "submenu" && item.title === "Project"
        ? {
            ...item,
            title: copy(item.title),
            // Only "All projects" carries a subtitle; project rows keep their own names.
            items: item.items.map((action) =>
              action.subtitle === undefined
                ? action
                : { ...action, title: copy(action.title), subtitle: copy(action.subtitle) },
            ),
          }
        : item,
    ),
  };
}

/** Android's filter menu actions, its project filter (`project`, `project:all`) reworded. */
export function withFolderFilterActionsCopy(
  actions: ReadonlyArray<MenuAction>,
  copy: (text: string) => string,
): MenuAction[] {
  return actions.map((action) =>
    action.id === "project"
      ? {
          ...action,
          title: copy(action.title),
          subactions: action.subactions?.map((sub) =>
            sub.id === "project:all" ? { ...sub, title: copy(sub.title) } : sub,
          ),
        }
      : action,
  );
}
