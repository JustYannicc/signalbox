import { type CheckpointRef, ProjectId, type ThreadId } from "@t3tools/contracts";
import * as SignalboxCheckpointRefs from "../signalbox/CheckpointRefs.ts";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  // signalbox: Keep new checkpoint refs isolated from T3 Code's shared refs.
  return SignalboxCheckpointRefs.checkpointRefForThreadTurn(threadId, turnCount);
}

function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}
