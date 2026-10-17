import { AutomationError, type ProjectId, type ThreadId } from "@t3tools/contracts";
import {
  FOLDER_PHASE_NAME_MAX_LENGTH,
  FolderSetPhaseInput,
} from "@t3tools/contracts/signalboxFolders";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { contextOfProject } from "../user/contextProjects.ts";
import { homeOf } from "../user/folderTree.ts";
import type { UserFolders } from "../user/UserFolders.ts";

/**
 * `set_folder_phase` (#677), for agents on their thread's machine
 * (`cloudTools.ts`) and automation steps (`cloudBuiltinTools.ts`): the folder
 * named, else the thread's home, through `UserFolders.setPhase`.
 */

const refuse = (message: string) => Effect.fail(new AutomationError({ message }));
const decodeInput = Schema.decodeUnknownEffect(FolderSetPhaseInput);

export const setFolderPhase = (
  folders: UserFolders["Service"],
  args: Readonly<Record<string, unknown>>,
  thread: { readonly threadId: ThreadId; readonly projectId: ProjectId } | null,
) =>
  Effect.gen(function* () {
    const named = typeof args.folderId === "string" && args.folderId !== "" ? args.folderId : null;
    const folderId = thread === null ? named : yield* folderFor(folders, thread, named);
    if (folderId === null)
      return yield* refuse("Pass folderId, or threadId of a thread in the folder.");
    const input = yield* decodeInput({
      id: folderId,
      ...(args.phases === undefined ? {} : { phases: args.phases }),
      ...(args.current === undefined ? {} : { current: args.current }),
    }).pipe(
      Effect.mapError(
        () =>
          new AutomationError({
            message: `Pass current as one of its phases, or phases as a list of names of up to ${FOLDER_PHASE_NAME_MAX_LENGTH} characters (null clears them).`,
          }),
      ),
    );
    const snapshot = yield* folders.setPhase(input).pipe(
      Effect.catchTags({
        FolderRefusedError: (error) => refuse(error.message),
        SqlError: (cause) =>
          Effect.fail(new AutomationError({ message: "Could not change the folder.", cause })),
      }),
    );
    const folder = snapshot.folders.find((candidate) => candidate.id === input.id);
    return { folderId: input.id, phase: folder?.phase ?? null };
  });

/**
 * The folder a thread's call acts on: the one named, if it's in the thread's
 * owner's tree, else the thread's home.
 */
const folderFor = (
  folders: UserFolders["Service"],
  thread: { readonly threadId: ThreadId; readonly projectId: ProjectId },
  named: string | null,
) =>
  Effect.gen(function* () {
    const state = yield* folders.state.pipe(
      Effect.mapError(
        (cause) => new AutomationError({ message: "Could not read your folders.", cause }),
      ),
    );
    const ownerId = contextOfProject(state.contexts, thread.projectId);
    if (named !== null) {
      const folder = state.tree.folders.find((candidate) => candidate.id === named);
      if (folder !== undefined && ownerId !== null && folder.ownerId !== ownerId) {
        return yield* refuse("That folder belongs to another of your trees than this thread.");
      }
      return named;
    }
    const home = homeOf(state.tree, { ...thread, ownerId });
    if (home === null) {
      return yield* refuse("This thread is at the top level, which has no phase. Pass folderId.");
    }
    return home;
  });
