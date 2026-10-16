import type { NoteCondition } from "@t3tools/contracts/signalboxNotes";
import type { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as DateTime from "effect/DateTime";

import { levelOf, poolTreeOf, type Tree } from "../user/folderTree.ts";
import { chainOf } from "../user/poolChain.ts";
import { type NoteRow, offerOf } from "./noteRows.ts";

/**
 * What a thread's agent may read of the notes (`list_notes`): the team notes
 * still on the pads of its home and the folders above it. A thread's agent
 * works for its folders, so it never reads a private note, and never another
 * folder's.
 */

export interface AgentNote {
  readonly text: string;
  readonly folder: string;
  /** `YYYY-MM-DD`, UTC. */
  readonly createdOn: string;
  readonly offer?: {
    readonly meaning: string;
    readonly action: string;
    readonly condition?: NoteCondition;
  };
}

/** `home` and every folder above it, nearest first; empty at the top level. */
export const chainFolderIds = (tree: Tree, home: FolderId | null): ReadonlyArray<FolderId> =>
  chainOf(poolTreeOf(tree), levelOf(home)).flatMap((level) =>
    level._tag === "folder" ? [level.folderId] : [],
  );

/** `rows` as the agent of a thread at `home` reads them, in their order. */
export const agentNotes = (
  tree: Tree,
  home: FolderId | null,
  rows: ReadonlyArray<NoteRow>,
): ReadonlyArray<AgentNote> => {
  const chain = new Set(chainFolderIds(tree, home));
  const byId = new Map(tree.folders.map((folder) => [folder.id, folder]));
  return rows.flatMap((row): Array<AgentNote> => {
    const folder =
      row.folder_id === null || !chain.has(row.folder_id) ? undefined : byId.get(row.folder_id);
    if (folder === undefined || row.visibility !== "team" || row.accepted_thread_id !== null) {
      return [];
    }
    const offer = offerOf(row);
    return [
      {
        text: row.text,
        folder: folder.name,
        createdOn: DateTime.formatIsoDateUtc(DateTime.makeUnsafe(row.created_at)),
        ...(offer === null
          ? {}
          : {
              offer: {
                meaning: offer.meaning,
                action: offer.action,
                ...(offer.condition === undefined ? {} : { condition: offer.condition }),
              },
            }),
      },
    ];
  });
};
