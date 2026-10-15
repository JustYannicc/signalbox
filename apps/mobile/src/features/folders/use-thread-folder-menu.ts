// signalbox: "Move to folder" in a thread's menu, where its environment keeps folders.
import { useAtomValue } from "@effect/atom-react";
import {
  type ThreadFolderChoice,
  threadFolderChoices,
} from "@t3tools/client-runtime/state/signalboxFolders";
import type { MenuAction } from "@react-native-menu/menu";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { useCallback } from "react";

import { folderEnvironmentsAtom, signalboxFolders } from "../../state/signalboxFolders";
import { useAtomCommand } from "../../state/use-atom-command";
import { folderPlacement } from "./folder-filter";
import {
  parseThreadFolderMenuEvent,
  THREAD_FOLDER_EVENT,
  threadFolderMenuActions,
} from "./folder-menus";
import { useFolderCommandRunner } from "./use-folder-actions";

interface ThreadFolderMenu {
  readonly choices: ReadonlyArray<ThreadFolderChoice>;
  readonly actions: MenuAction[];
}

const NO_MENU: ThreadFolderMenu = { choices: [], actions: [] };
const isEnvironmentId = Schema.is(EnvironmentId);
const isThreadId = Schema.is(ThreadId);
const isProjectId = Schema.is(ProjectId);

const sameChoices = (
  left: ReadonlyArray<ThreadFolderChoice>,
  right: ReadonlyArray<ThreadFolderChoice>,
) =>
  left.length === right.length &&
  left.every(
    (choice, index) =>
      choice.folderId === right[index]!.folderId &&
      choice.label === right[index]!.label &&
      choice.checked === right[index]!.checked,
  );

type ThreadRef = {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
};

/**
 * One thread's menu items, worked out once from every folder environment.
 * It keeps its value until the thread's own choices change, so a folder
 * change elsewhere doesn't redraw the thread's row.
 */
const threadFolderMenuAtom = Atom.family((key: string) => {
  const [environmentId, id, projectId] = key.split("\n");
  return Atom.make((get): ThreadFolderMenu => {
    if (!isEnvironmentId(environmentId) || !isThreadId(id) || !isProjectId(projectId)) {
      return NO_MENU;
    }
    const environment = get(folderEnvironmentsAtom).get(environmentId);
    const placement = environment
      ? folderPlacement(environment.snapshot, environment.owners, { id, projectId })
      : null;
    if (!environment || !placement) return NO_MENU;
    const choices = threadFolderChoices(environment.snapshot, placement.ownerId, placement.home);
    const previous = Option.getOrUndefined(get.self<ThreadFolderMenu>());
    if (previous !== undefined && sameChoices(previous.choices, choices)) return previous;
    return { choices, actions: threadFolderMenuActions(choices) };
  }).pipe(Atom.withLabel("signalbox-thread-folder-menu"));
});

const keyOf = (thread: ThreadRef) => `${thread.environmentId}\n${thread.id}\n${thread.projectId}`;

/**
 * The thread's menu items and a handler that returns whether it took the
 * choice. Empty where folders don't exist or the owner has none yet.
 */
export function useThreadFolderMenu(thread: ThreadRef) {
  const menu = useAtomValue(threadFolderMenuAtom(keyOf(thread)));
  const moveThread = useAtomCommand(signalboxFolders.moveThread, { reportFailure: false });
  const run = useFolderCommandRunner();
  const { environmentId, id } = thread;
  const onAction = useCallback(
    (event: string): boolean => {
      if (!event.startsWith(THREAD_FOLDER_EVENT)) return false;
      const target = parseThreadFolderMenuEvent(menu.choices, event);
      if (target !== undefined) {
        void run(
          "Couldn’t move the thread",
          moveThread({ environmentId, input: { threadId: id, folderId: target.folderId } }),
        );
      }
      return true;
    },
    [environmentId, id, menu.choices, moveThread, run],
  );
  return { items: menu.actions, onAction };
}
