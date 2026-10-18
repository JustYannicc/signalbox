import * as Effect from "effect/Effect";

import { homeOf } from "../user/folderTree.ts";
import type { ClientTraceDimension } from "../user/UserDirectory.ts";
import * as UserContexts from "../user/UserContexts.ts";
import * as UserFolders from "../user/UserFolders.ts";
import * as UserStore from "../user/UserStore.ts";

const GENERATED_THREAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORGANIZATION_CONTEXT_ID = /^org_[0-9A-HJKMNP-TV-Z]{26}$/;
const GENERATED_FOLDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve only UUID threads in this user's currently accessible contexts. */
export const clientTraceDimensions = (threadIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const requestedIds = [...new Set(threadIds.filter((id) => GENERATED_THREAD_ID.test(id)))];
    if (requestedIds.length === 0) return [];

    const index = yield* UserStore.UserStore.use((store) => store.threadIndex);
    const contextIds = yield* UserContexts.UserContexts.use((contexts) => contexts.contextIds);
    const folderState = yield* UserFolders.UserFolders.use((folders) => folders.state);
    const visibleContexts = new Set(contextIds);
    const indexed = new Map<string, (typeof index.threads)[number]>(
      index.threads
        .filter(
          ({ contextId, shell }) => visibleContexts.has(contextId) && shell.deletedAt === null,
        )
        .map((thread) => [thread.shell.id, thread] as const),
    );

    const dimensions: Array<ClientTraceDimension> = [];
    for (const threadId of requestedIds) {
      const thread = indexed.get(threadId);
      if (thread === undefined) continue;

      const contextId = thread.contextId;
      dimensions.push({
        threadId,
        folderId: homeOf(folderState.tree, {
          threadId: thread.shell.id,
          projectId: thread.shell.projectId,
          ownerId: contextId,
        }),
        orgId: ORGANIZATION_CONTEXT_ID.test(contextId) ? contextId : null,
      });
    }
    return dimensions;
  });

/** Resolve folder-only telemetry context from the user's current accessible tree. */
export const clientFolderDimensions = (folderIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const requested = new Set(folderIds.filter((id) => GENERATED_FOLDER_ID.test(id)));
    if (requested.size === 0) return [];

    const folderState = yield* UserFolders.UserFolders.use((folders) => folders.state);
    return folderState.tree.folders.flatMap((folder) =>
      requested.has(folder.id)
        ? [
            {
              folderId: folder.id,
              orgId: ORGANIZATION_CONTEXT_ID.test(folder.ownerId) ? folder.ownerId : null,
            },
          ]
        : [],
    );
  });
