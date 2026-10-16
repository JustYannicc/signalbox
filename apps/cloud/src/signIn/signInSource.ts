import { ProjectId, ThreadId } from "@t3tools/contracts";
import type { FolderId } from "@t3tools/contracts/signalboxFolders";
import { type SignalboxContext, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import type { SignInSource } from "@t3tools/contracts/signalboxSignIn";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { homeOf, type Tree } from "../user/folderTree.ts";
import * as UserFolders from "../user/UserFolders.ts";

/**
 * Whose credentials a thread's sign-ins use (#344, 2026-10-16): credentials
 * follow the folder tree. A thread at home in an organization's folder signs
 * in with that folder's source, the same whoever is talking; anywhere in the
 * person's own tree, with their own 1Password. A person's credentials reach
 * an organization's folder only by lending (#230), never by default.
 */
export const sourceOfHome = (
  tree: Tree,
  contexts: ReadonlyArray<SignalboxContext>,
  home: FolderId | null,
): SignInSource => {
  const folder = home === null ? undefined : tree.folders.find((each) => each.id === home);
  const owner =
    folder === undefined ? undefined : contexts.find((context) => context.id === folder.ownerId);
  return folder !== undefined && owner?.kind === "organization"
    ? { _tag: "folder", folderId: folder.id }
    : { _tag: "person" };
};

const decodeIndexed = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({ context_id: SignalboxContextId, project_id: Schema.NullOr(ProjectId) }),
  ),
);

/** The source for a thread of this person's, from its home now: a moved thread follows its new home. */
export const makeThreadSources = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const folders = yield* UserFolders.UserFolders;
  return (threadId: string) =>
    Effect.gen(function* () {
      const state = yield* folders.state;
      const [row] = decodeIndexed(
        yield* sql`SELECT context_id, json_extract(shell, '$.projectId') AS project_id
          FROM thread_index WHERE thread_id = ${threadId}`,
      );
      const home = homeOf(state.tree, {
        threadId: ThreadId.make(threadId),
        projectId: row?.project_id ?? null,
        ownerId: row?.context_id ?? null,
      });
      return sourceOfHome(state.tree, state.contexts, home);
    });
});
