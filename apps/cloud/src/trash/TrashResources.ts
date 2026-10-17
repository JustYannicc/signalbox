import type { FolderId } from "@t3tools/contracts/signalboxFolders";
import { SignalboxTrashError } from "@t3tools/contracts/signalboxTrash";
import type { Actor } from "../thread/ThreadEngine.ts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { Removal, Row, Target } from "./trashTables.ts";

export interface FolderTrash {
  readonly id: string;
  readonly folderId: string;
  readonly title: string;
  readonly contextId: string;
  readonly deletedAt: number;
  readonly purgeAfter: number;
  readonly targets: ReadonlyArray<Target>;
  readonly driveIds: ReadonlyArray<string>;
}

/** Resource owners fence every call by the trash id and retain receipts after purging. */
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
    readonly purge: (
      actor: Actor,
      row: Row,
    ) => Effect.Effect<ReadonlyArray<Removal>, SignalboxTrashError>;
    readonly collect: (
      actor: Actor,
      row: Row,
    ) => Effect.Effect<ReadonlyArray<Removal>, SignalboxTrashError>;
    readonly acknowledge?: (id: string) => Effect.Effect<void, SignalboxTrashError>;
  }
>()("@signalbox/cloud/trash/TrashResources") {}
