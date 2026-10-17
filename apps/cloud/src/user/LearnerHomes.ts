import { ProjectId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { poolObjectName, type ModelPoolRoute } from "../pool/PoolDirectory.ts";

import { homeOf, isWithin, poolResolver } from "./folderTree.ts";
import { makeProfileId } from "./profileId.ts";
import * as UserFolders from "./UserFolders.ts";

export class LearnerAccessError extends Schema.TaggedError<LearnerAccessError>()(
  "LearnerAccessError",
  { reason: Schema.Literals(["unknown-thread", "not-member", "not-below"]) },
) {
  override get message() {
    return "That learner is outside this thread's level.";
  }
}

/** An authorized level inside this person's object. Callers never supply these keys. */
export interface LearnerHome {
  readonly scope: string;
  readonly treeId: string;
  readonly folderId: FolderId | null;
  readonly pool: ModelPoolRoute | null;
}

const IndexedThread = Schema.Struct({
  context_id: SignalboxContextId,
  project_id: ProjectId,
});
const decodeIndex = Schema.decodeUnknownSync(Schema.Array(IndexedThread));

export class LearnerHomes extends Context.Service<
  LearnerHomes,
  {
    readonly home: (
      threadId: ThreadId,
    ) => Effect.Effect<LearnerHome, LearnerAccessError | SqlError>;
    /** Higher levels may ask for a descendant's lens summaries, never its raw evidence. */
    readonly lower: (
      threadId: ThreadId,
      folderId: FolderId,
    ) => Effect.Effect<LearnerHome, LearnerAccessError | SqlError>;
  }
>()("@signalbox/cloud/user/LearnerHomes") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const folders = yield* UserFolders.UserFolders;
  const userId = yield* makeProfileId;
  const resolve = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const person = yield* userId;
      const [thread] = decodeIndex(
        yield* sql`SELECT context_id, json_extract(shell, '$.projectId') AS project_id
          FROM thread_index WHERE thread_id = ${threadId}`,
      );
      if (person === null || thread === undefined) {
        return yield* new LearnerAccessError({ reason: "unknown-thread" });
      }
      const state = yield* folders.state;
      if (!state.contexts.some((context) => context.id === thread.context_id)) {
        return yield* new LearnerAccessError({ reason: "not-member" });
      }
      const folderId = homeOf(state.tree, {
        threadId,
        projectId: thread.project_id,
        ownerId: thread.context_id,
      });
      if (
        folderId !== null &&
        !state.tree.folders.some(
          (folder) => folder.id === folderId && folder.ownerId === thread.context_id,
        )
      ) {
        return yield* new LearnerAccessError({ reason: "not-member" });
      }
      yield* Effect.annotateCurrentSpan({
        "person.id": person,
        "owner.id": thread.context_id,
        ...(folderId === null ? {} : { "folder.id": folderId }),
      });
      // A user's private root is never a company root. Folder ids are scoped by their owner too.
      const at = (id: FolderId | null): LearnerHome => {
        const pool = poolResolver(state.tree)(id);
        return {
          scope: JSON.stringify([
            thread.context_id === PERSONAL_CONTEXT_ID ? "person" : "company",
            person,
            thread.context_id,
            id,
          ]),
          treeId: thread.context_id,
          folderId: id,
          pool:
            pool === null
              ? null
              : {
                  objectName: poolObjectName(person, pool.poolId),
                  userId: person,
                },
        };
      };
      return { home: at(folderId), at, state, ownerId: thread.context_id };
    });
  return LearnerHomes.of({
    home: (threadId) => Effect.map(resolve(threadId), (resolved) => resolved.home),
    lower: (threadId, folderId) =>
      Effect.gen(function* () {
        const resolved = yield* resolve(threadId);
        const folder = resolved.state.tree.folders.find((candidate) => candidate.id === folderId);
        if (
          folder?.ownerId !== resolved.ownerId ||
          folderId === resolved.home.folderId ||
          (resolved.home.folderId !== null &&
            !isWithin(resolved.state.tree, folderId, resolved.home.folderId))
        ) {
          return yield* new LearnerAccessError({ reason: "not-below" });
        }
        return resolved.at(folderId);
      }),
  });
});

export const layer = Layer.effect(LearnerHomes, make);
