/** signalbox: what the navigation panel calls itself, by which kinds of tree it lists. */
import { folderWording } from "./folder-copy";

export interface NavigationPanelCopy {
  readonly title: string;
  readonly subtitle: string;
  readonly show: string;
  readonly hide: string;
}

/** Self-hosted environments only: their sections panel, as it always was. */
const SECTIONS: NavigationPanelCopy = {
  title: "Sections",
  subtitle: "Choose a project to show its threads.",
  show: "Browse sections",
  hide: "Hide sections",
};
const FOLDERS: NavigationPanelCopy = {
  title: "Folders",
  subtitle: "Choose a folder to show its threads.",
  show: "Browse folders",
  hide: "Hide folders",
};
/** Folders beside a self-hosted environment's tree: words that fit both. */
const MIXED: NavigationPanelCopy = {
  title: "Browse",
  subtitle: "Choose where to show threads from.",
  show: "Browse",
  hide: "Hide",
};

export function navigationPanelCopy(input: {
  readonly withFolders: number;
  readonly total: number;
}): NavigationPanelCopy {
  return { projects: SECTIONS, folders: FOLDERS, mixed: MIXED }[folderWording(input)];
}

/**
 * The panel toggle's words across every environment the app knows. Folders
 * until one reports otherwise, so the cloud never says sections while loading.
 */
export function navigationToggleCopy(
  capabilities: Iterable<{ readonly folders?: boolean | undefined }>,
): Pick<NavigationPanelCopy, "show" | "hide"> {
  let total = 0;
  let withFolders = 0;
  for (const capability of capabilities) {
    total += 1;
    if (capability.folders === true) withFolders += 1;
  }
  const { show, hide } = total === 0 ? FOLDERS : navigationPanelCopy({ withFolders, total });
  return { show, hide };
}
