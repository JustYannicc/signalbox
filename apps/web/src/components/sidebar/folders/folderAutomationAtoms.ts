/**
 * Each Home list's automations, as atoms so a run changing state redraws only
 * the rows it changes, never the folder tree. Reads the same per-environment
 * subscriptions as every other automation view.
 */
import { environmentListKey } from "@t3tools/client-runtime/state/automations";
import type { Automation } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { automationState } from "../../../state/automations";
import { environmentSummaries } from "../../../state/presentation";
import { folderAutomationLists, sameAutomationRows } from "./automationHomes";
import { sameEntries, type FolderListKey } from "./folderSidebarModel";
import { folderTreesAtom } from "./folderThreads";

const folderAutomationListsAtom = Atom.make((get) => {
  const previous = Option.getOrUndefined(
    get.self<ReadonlyMap<FolderListKey, ReadonlyArray<Automation>>>(),
  );
  const lists = get(
    automationState.lists(
      environmentListKey(get(environmentSummaries.connectedEnvironmentIdsAtom)),
    ),
  );
  const next = new Map<FolderListKey, ReadonlyArray<Automation>>();
  for (const tree of get(folderTreesAtom).values()) {
    const automations = lists.find(
      (list) => list.environmentId === tree.environmentId,
    )?.automations;
    if (!automations || automations.length === 0) continue;
    for (const [listKey, list] of folderAutomationLists(
      tree.environmentId,
      tree.owners,
      tree.snapshot,
      automations,
    )) {
      const before = previous?.get(listKey);
      next.set(listKey, before !== undefined && sameAutomationRows(before, list) ? before : list);
    }
  }
  return previous !== undefined && sameEntries(previous, next) ? previous : next;
}).pipe(Atom.withLabel("web-folder-automation-lists"));

const NO_AUTOMATIONS: ReadonlyArray<Automation> = [];

/** One Home list's automations: the same array until a row would draw differently. */
export const folderAutomationsAtom = Atom.family((listKey: FolderListKey) =>
  Atom.make((get) => get(folderAutomationListsAtom).get(listKey) ?? NO_AUTOMATIONS).pipe(
    Atom.withLabel(`web-folder-automations:${listKey}`),
  ),
);
