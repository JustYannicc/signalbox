import type { FolderInstructions } from "@signalbox/runner-protocol/DriveProtocol";
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { TurnInstructions } from "./turnPool.ts";

/**
 * What `CloudThreadService` asks about a thread's kind before a command that
 * can start a turn (#46). The owner's object answers (`user/UserThreadKinds.ts`):
 * it classifies a thread from its first message, and says what its agent is
 * told about being a chat or a task.
 */
export class ThreadKindTurns extends Context.Service<
  ThreadKindTurns,
  {
    /**
     * The kind's instruction level for the thread's next turn, or null when
     * its kind isn't known. `message`: what the command sends, which a
     * thread's first message is classified by; `title` when the command
     * names one (the thread's own otherwise).
     */
    readonly beforeTurn: (
      threadId: ThreadId,
      message: { readonly text: string; readonly title?: string | undefined } | null,
    ) => Effect.Effect<FolderInstructions | null>;
  }
>()("@signalbox/cloud/thread/ThreadKindTurns") {}

/** Kinds unknown: the Worker, which only reads threads, and tests that don't care. */
export const layerNone = Layer.succeed(
  ThreadKindTurns,
  ThreadKindTurns.of({ beforeTurn: () => Effect.succeed(null) }),
);

/** `instructions` with `level` last on every home's chain. */
export const withLevel = (
  instructions: TurnInstructions,
  level: FolderInstructions | null,
): TurnInstructions => {
  if (level === null) return instructions;
  const add = (levels: ReadonlyArray<FolderInstructions>) => [...levels, level];
  return {
    top: add(instructions.top),
    projects: Object.fromEntries(
      Object.entries(instructions.projects).map(([projectId, levels]) => [projectId, add(levels)]),
    ),
    ...(instructions.thread === undefined ? {} : { thread: add(instructions.thread) }),
  };
};
