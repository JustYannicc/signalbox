import type { CommandId, OrchestrationV2Run } from "@t3tools/contracts";

export const stopRunCommand = (
  commandId: CommandId,
  run: Pick<OrchestrationV2Run, "id" | "threadId" | "status">,
  reason?: string,
) =>
  run.status === "queued"
    ? {
        type: "queued-run.cancel" as const,
        commandId,
        threadId: run.threadId,
        runId: run.id,
      }
    : {
        type: "run.interrupt" as const,
        commandId,
        threadId: run.threadId,
        runId: run.id,
        ...(reason === undefined ? {} : { reason }),
      };
