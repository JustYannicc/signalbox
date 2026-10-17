import { CommandId, type ThreadId } from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import { remoteThreadWorktree } from "../../user/contextProjects.ts";
import type { ThreadContexts } from "../../user/threadContexts.ts";
import type { Actor } from "../ThreadAccess.ts";
import type { ThreadDirectory } from "../ThreadDirectory.ts";

/** Reads the authoritative home before adopting a published drive, without changing its execution path. */
export const makeWorkspaceRefresh =
  ({
    directory,
    threadContexts,
    crypto,
  }: {
    readonly directory: ThreadDirectory["Service"];
    readonly threadContexts: ThreadContexts["Service"];
    readonly crypto: Crypto.Crypto;
  }) =>
  (actor: Actor, threadId: ThreadId) =>
    Effect.gen(function* () {
      const handle = directory.forThread(threadId);
      const snapshot = yield* handle.snapshot(actor);
      const { projection } = snapshot;
      if (projection.thread.branch !== null || projection.thread.worktreePath !== null)
        return snapshot;
      const place = yield* threadContexts.placeOfProject(projection.thread.projectId);
      if (place?.remote !== true) return snapshot;
      yield* handle.dispatch(
        actor,
        {
          type: "thread.metadata.update",
          commandId: CommandId.make(yield* Effect.orDie(crypto.randomUUIDv4())),
          threadId,
        },
        {
          place: null,
          pools: null,
          worktree: remoteThreadWorktree(place.driveId, threadId),
        },
      );
      return yield* handle.snapshot(actor);
    });
