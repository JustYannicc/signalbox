import type { FolderId } from "@t3tools/contracts/signalboxFolders";
import type { TrashPlannedRemoval } from "@t3tools/contracts/signalboxTrash";
import { SignalboxTrashError } from "@t3tools/contracts/signalboxTrash";
import type { Actor } from "../thread/ThreadEngine.ts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { Row, Target } from "./trashTables.ts";

export interface FolderTrash {
  readonly id: string;
  readonly folderId: string;
  readonly title: string;
  readonly contextId: string;
  readonly deletedAt: number;
  readonly purgeAfter: number;
  readonly targets: ReadonlyArray<Target>;
  readonly driveIds: ReadonlyArray<string>;
  readonly plannedRemovals: ReadonlyArray<TrashPlannedRemoval>;
}

/** Resource owners fence every state-changing call by the trash id. */
export class TrashResources extends Context.Service<
  TrashResources,
  {
    readonly describeThread: (
      actor: Actor,
      threadId: string,
    ) => Effect.Effect<
      {
        readonly title: string;
        readonly contextId: string;
        readonly target: Target;
        readonly plannedRemovals: ReadonlyArray<TrashPlannedRemoval>;
      },
      SignalboxTrashError
    >;
    readonly trashFolder: (
      actor: Actor,
      folderId: FolderId,
    ) => Effect.Effect<FolderTrash, SignalboxTrashError>;
    readonly folderTrashes: (
      actor: Actor,
    ) => Effect.Effect<ReadonlyArray<FolderTrash>, SignalboxTrashError>;
    readonly prepare: (actor: Actor, row: Row) => Effect.Effect<boolean, SignalboxTrashError>;
    readonly restore: (actor: Actor, row: Row) => Effect.Effect<void, SignalboxTrashError>;
  }
>()("@signalbox/cloud/trash/TrashResources") {}
