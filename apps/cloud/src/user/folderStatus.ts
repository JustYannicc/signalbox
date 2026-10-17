import type { FolderStatusAnswer } from "@signalbox/runner-protocol/StatusLineProtocol";
import { threadHomeLookup } from "@t3tools/client-runtime/state/foldersModel";
import {
  folderStatusRollups,
  folderStatusSummary,
  type FolderStatusCounts,
  type StatusResident,
  threadStatusHeadline,
  threadStatusOf,
  type ThreadStatusState,
} from "@t3tools/client-runtime/state/threadStatusLine";
import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import type { FolderId, SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import type { ThreadStatusNote } from "@t3tools/contracts/signalboxStatusLine";
import * as DateTime from "effect/DateTime";

import { noteView } from "../thread/statusLine/statusNotePolicy.ts";

/**
 * What's going on in a thread's home folder (#670), for its agent's
 * `folder_status`: the roll-up people see (`folderStatusRollups`), and each
 * live thread at home there or below with its line, so the agent can answer
 * "what's going on?". A thread at its owner's top level gets the top level:
 * every live thread they can see. Pure, over the owner's folders, index and notes.
 */

/** Threads listed at most; the rest only count. */
const LISTED = 30;

/** People's attention first, then work in motion. */
const ORDER: Record<ThreadStatusState, number> = {
  waiting_on_person: 0,
  working: 1,
  waiting_on_other: 2,
  idle: 3,
  archived: 4,
};

const ZERO: FolderStatusCounts = { working: 0, waiting: 0, idle: 0 };

export const folderStatusAnswer = (input: {
  readonly snapshot: SignalboxFoldersSnapshot;
  /** The threads the owner sees: in their contexts, not deleted. */
  readonly shells: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly notes: ReadonlyMap<string, ThreadStatusNote>;
  readonly threadId: ThreadId;
}): FolderStatusAnswer => {
  const { snapshot, shells, notes } = input;
  const homeOf = threadHomeLookup(snapshot);
  const self = shells.find((shell) => shell.id === input.threadId);
  const home: FolderId | null = self === undefined ? null : homeOf(self);
  const parentOf = new Map(snapshot.folders.map((folder) => [folder.id, folder.parentId]));
  /** Whether a thread living in `folder` is at home in `home` or below. */
  const isUnder = (folder: FolderId | null) => {
    if (home === null) return true;
    const seen = new Set<FolderId>();
    for (let id = folder; id !== null && !seen.has(id); id = parentOf.get(id) ?? null) {
      if (id === home) return true;
      seen.add(id);
    }
    return false;
  };
  const residents = shells.map((shell) => ({
    shell,
    status: threadStatusOf(shell),
    resident: {
      id: shell.id,
      projectId: shell.projectId,
      state: threadStatusOf(shell).state,
      updatedAt: DateTime.formatIso(shell.updatedAt),
    } satisfies StatusResident,
  }));
  const live = residents.filter(
    (entry) => entry.status.state !== "archived" && isUnder(homeOf(entry.shell)),
  );
  const rollup =
    home === null
      ? {
          counts: live.reduce(
            (counts, { status }) => ({
              working: counts.working + (status.state === "working" ? 1 : 0),
              waiting:
                counts.waiting +
                (status.state === "waiting_on_person" || status.state === "waiting_on_other"
                  ? 1
                  : 0),
              idle: counts.idle + (status.state === "idle" ? 1 : 0),
            }),
            ZERO,
          ),
          highlights: live
            .filter(({ status }) => status.state === "waiting_on_person")
            .map(({ resident }) => resident)
            .toSorted((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))
            .slice(0, 2)
            .map((resident) => ({
              threadId: resident.id,
              reason: "oldest_waiting_on_person",
              since: resident.updatedAt,
            })),
        }
      : (folderStatusRollups(
          snapshot,
          residents.map(({ resident }) => resident),
        ).get(home) ?? { counts: ZERO, highlights: [] });
  const listed = live
    .toSorted(
      (left, right) =>
        ORDER[left.status.state] - ORDER[right.status.state] ||
        Date.parse(right.resident.updatedAt) - Date.parse(left.resident.updatedAt),
    )
    .slice(0, LISTED);
  const folder = home === null ? undefined : snapshot.folders.find((entry) => entry.id === home);
  return {
    folder: folder === undefined ? null : { id: folder.id, name: folder.name },
    counts: rollup.counts,
    summary: folderStatusSummary(rollup.counts),
    highlights: rollup.highlights,
    threads: listed.map(({ shell, status }) => {
      const note = notes.get(shell.id);
      return {
        threadId: shell.id,
        title: shell.title,
        state: status.state,
        headline: threadStatusHeadline(status),
        note: note === undefined ? null : noteView(note),
      };
    }),
    more: live.length - listed.length,
  };
};
