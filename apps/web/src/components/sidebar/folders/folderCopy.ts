/**
 * signalbox: upstream's "project" words, said the folder way where the
 * environment keeps folders (`capabilities.folders`). Every other environment
 * keeps upstream's exact wording, so these return it unchanged there.
 */
import { TOP_LEVEL_NAME } from "@t3tools/client-runtime/state/signalboxFolders";

/** What the new-thread hero calls its picker, its rows and the way out of a project. */
export interface DraftHeroCopy {
  /** The picker's label on a draft without a project (upstream's scratch project). */
  readonly scratchLabel: string;
  readonly choose: string;
  readonly add: string;
  readonly addToStart: string;
  readonly addRow: string;
  readonly search: string;
  readonly searchPlaceholder: string;
  readonly noMatches: string;
  readonly startWithout: string;
  readonly startWithoutFailed: string;
}

export const PROJECT_HERO_COPY: DraftHeroCopy = {
  scratchLabel: "No project",
  choose: "Choose a project",
  add: "Add a project",
  addToStart: "Add a project to start",
  addRow: "Add project",
  search: "Search projects",
  searchPlaceholder: "Search projects...",
  noMatches: "No matching projects.",
  startWithout: "or start without a project",
  startWithoutFailed: "Could not start without a project",
};

/**
 * With folders, a thread without a project lives at your top level: nothing
 * is without a home there (#227). Without folders, upstream's project words.
 */
export function draftHeroCopy(folders: boolean): DraftHeroCopy {
  if (!folders) return PROJECT_HERO_COPY;
  return {
    scratchLabel: TOP_LEVEL_NAME,
    choose: "Choose a folder",
    add: "Add a source",
    addToStart: "Add a source to start",
    addRow: "Add a source",
    search: "Search folders",
    searchPlaceholder: "Search folders...",
    noMatches: "No matching folders.",
    startWithout: "or start at the top level",
    startWithoutFailed: "Could not start at the top level",
  };
}

/**
 * What opening a thread's project settings is called. A thread's project is
 * the files it works in, which the folder menu calls "Files".
 */
export function projectSettingsLabel(folders: boolean): string {
  return folders ? "Files settings" : "Project settings";
}
