// signalbox: Home's sections panel state. Home renders the panel and the iOS
// workspace toolbar owns its toggle, so the two share it here.
import { Atom } from "effect/reactivity";

import { navigationPanelCopy } from "../folders/panel-copy";
import { environmentServerConfigsAtom } from "../../state/server";

export const sectionsPanelOpenAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("signalbox:sections-panel-open"),
);

/**
 * What the panel calls itself across every connected environment. The copy is
 * one of a few constants, so readers only update when the wording changes.
 */
export const sectionsPanelCopyAtom = Atom.make((get) => {
  const configs = [...get(environmentServerConfigsAtom).values()];
  return navigationPanelCopy({
    withFolders: configs.filter((config) => config.environment.capabilities.folders === true)
      .length,
    total: configs.length,
  });
}).pipe(Atom.withLabel("signalbox:sections-panel-copy"));
