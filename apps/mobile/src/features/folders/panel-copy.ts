/** signalbox: what the navigation panel calls itself, by which kinds of tree it lists. */
export interface NavigationPanelCopy {
  readonly title: string;
  readonly subtitle: string;
  readonly hide: string;
}

/** Self-hosted environments only: their sections panel, as it always was. */
const SECTIONS: NavigationPanelCopy = {
  title: "Sections",
  subtitle: "Choose a project to show its threads.",
  hide: "Hide sections",
};
const FOLDERS: NavigationPanelCopy = {
  title: "Folders",
  subtitle: "Choose a folder to show its threads.",
  hide: "Hide folders",
};
/** Folders beside a self-hosted environment's tree: words that fit both. */
const MIXED: NavigationPanelCopy = {
  title: "Browse",
  subtitle: "Choose where to show threads from.",
  hide: "Hide",
};

export function navigationPanelCopy(input: {
  readonly withFolders: number;
  readonly total: number;
}): NavigationPanelCopy {
  if (input.withFolders === 0) return SECTIONS;
  return input.withFolders === input.total ? FOLDERS : MIXED;
}
