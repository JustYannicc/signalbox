/**
 * Where automations show in the Home tree (#313): an automation lives where
 * its project's threads live, so each one sits in its owner's list for that
 * project's home, next to that home's threads. Pure; `FolderAutomations`
 * draws it.
 */
import { needsAttention, sortAutomations } from "@t3tools/client-runtime/automations/list";
import { homeOfProject } from "@t3tools/client-runtime/state/signalboxFolders";
import type { Automation, EnvironmentId } from "@t3tools/contracts";
import type { SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";

import {
  folderThreadListKey,
  projectOwners,
  type FolderListKey,
  type FolderOwner,
} from "./folderSidebarModel";

/**
 * Each list's automations, needs-you first, then by name. Automations of a
 * project no owner holds show nowhere, like that project's threads.
 */
export function folderAutomationLists(
  environmentId: EnvironmentId,
  owners: ReadonlyArray<FolderOwner>,
  snapshot: SignalboxFoldersSnapshot,
  automations: ReadonlyArray<Automation>,
): Map<FolderListKey, Automation[]> {
  const ownerOf = projectOwners(owners);
  const lists = new Map<FolderListKey, Automation[]>();
  const byName = sortAutomations(
    automations.map((automation) => ({ automation })),
    "name",
  );
  // Stable sort: needs-you first, each part still by name.
  byName.sort(
    (left, right) =>
      Number(needsAttention(right.automation)) - Number(needsAttention(left.automation)),
  );
  for (const { automation } of byName) {
    const owner = ownerOf.get(automation.projectId);
    if (owner === undefined) continue;
    const key = folderThreadListKey(
      environmentId,
      owner.context.id,
      homeOfProject(snapshot, automation.projectId),
    );
    const list = lists.get(key);
    if (list) list.push(automation);
    else lists.set(key, [automation]);
  }
  return lists;
}

/**
 * The run an automation's row opens on: the one waiting on an answer, else
 * its latest run when that failed; null opens the automation as it is.
 */
export function attentionRunId(automation: Pick<Automation, "waiting" | "lastRun">): string | null {
  const waiting = automation.waiting[0];
  if (waiting) return waiting.runId;
  return automation.lastRun?.status === "failed" ? automation.lastRun.id : null;
}

/**
 * Whether two lists draw the same rows: the same automations with the same
 * name, switch and attention. Every list update brings new objects, so a list
 * that draws the same keeps its old array and its rows don't redraw.
 */
export function sameAutomationRows(
  left: ReadonlyArray<Automation>,
  right: ReadonlyArray<Automation>,
): boolean {
  return (
    left.length === right.length &&
    left.every((automation, index) => {
      const other = right[index]!;
      return (
        automation.id === other.id &&
        automation.name === other.name &&
        automation.enabled === other.enabled &&
        automation.waiting.length === other.waiting.length &&
        attentionRunId(automation) === attentionRunId(other) &&
        needsAttention(automation) === needsAttention(other)
      );
    })
  );
}

/** What the folded row of a home's automations says: "1 automation", "3 automations". */
export function automationCountLabel(count: number): string {
  return count === 1 ? "1 automation" : `${count} automations`;
}
