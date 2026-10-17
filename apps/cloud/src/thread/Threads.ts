import type {
  OrchestrationV2Command,
  OrchestrationV2SubscribeThreadInput,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ThreadLaunchInput,
  OrchestrationV2ThreadLaunchResult,
  OrchestrationV2ThreadStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type {
  Actor,
  ThreadCommandRejectedError,
  ThreadNotFoundError,
  ThreadObjectError,
} from "./ThreadAccess.ts";

type ThreadReadError = ThreadNotFoundError | ThreadObjectError;
type ThreadError = ThreadReadError | ThreadCommandRejectedError;

export class Threads extends Context.Service<
  Threads,
  {
    /** A missing thread id is derived from actor + command id, so retrying a launch cannot duplicate it. */
    readonly launch: (
      actor: Actor,
      input: OrchestrationV2ThreadLaunchInput,
    ) => Effect.Effect<OrchestrationV2ThreadLaunchResult, ThreadError>;
    /** Resolves the turn's home and attachments before the serialized command/receipt commit. */
    readonly dispatch: (
      actor: Actor,
      command: OrchestrationV2Command,
    ) => Effect.Effect<{ readonly sequence: number }, ThreadError>;
    readonly snapshot: (
      actor: Actor,
      threadId: ThreadId,
    ) => Effect.Effect<OrchestrationV2ThreadBoundedSnapshot, ThreadReadError>;
    readonly history: (
      actor: Actor,
      threadId: ThreadId,
    ) => Effect.Effect<OrchestrationV2ThreadHistoryPage, ThreadReadError>;
    /** Snapshot or replay, optional synchronization marker, then committed events; recovery owns the cursor. */
    readonly subscribe: (
      actor: Actor,
      input: OrchestrationV2SubscribeThreadInput,
    ) => Stream.Stream<ReadonlyArray<OrchestrationV2ThreadStreamItem>, ThreadError>;
  }
>()("@signalbox/cloud/thread/Threads") {}
