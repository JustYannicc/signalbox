import type { NoteCondition, NoteOffer } from "@t3tools/contracts/signalboxNotes";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { ellipsize } from "@t3tools/shared/String";

import { projectIdForContext, projectIdForDrive } from "../user/contextProjects.ts";
import type { TreeFolder } from "../user/folderTree.ts";

/**
 * The task an accepted offer starts (#318): where it works, its title, and
 * its first message, which is the note's own words before anything the
 * reader made of them, so the task's origin stays the person's.
 */

const TITLE_MAX = 80;

/** One line from the offer's meaning, at most `TITLE_MAX` long. */
const titleOf = (meaning: string) => ellipsize(meaning.replace(/\s+/g, " ").trim(), TITLE_MAX);

const waitingFor = (condition: NoteCondition) =>
  condition._tag === "pullRequestMerged" ? `#${condition.number} merges` : condition.on;

/**
 * `folder`'s files, or its owner's own when it has none, as a new thread
 * there gets; the top level's is Personal's, Scratch.
 */
const projectOf = (folder: TreeFolder | null) =>
  folder === null
    ? projectIdForContext(PERSONAL_CONTEXT_ID)
    : folder.driveId === null
      ? projectIdForContext(folder.ownerId)
      : projectIdForDrive(folder.driveId);

export const noteTask = (
  note: { readonly text: string },
  offer: NoteOffer,
  folder: TreeFolder | null,
) => {
  const reader = offer.reader === "folder" ? `The ${folder?.name ?? ""} agent` : "My assistant";
  return {
    projectId: projectOf(folder),
    title: titleOf(offer.meaning),
    text: [
      note.text,
      "",
      `From my notes. ${reader} read it as: ${offer.meaning} ${offer.action}`,
      ...(offer.condition === undefined
        ? []
        : [
            `Prepare it now, but don't land anything until ${waitingFor(offer.condition)}, and say that's what it's waiting on.`,
          ]),
    ].join("\n"),
  };
};
