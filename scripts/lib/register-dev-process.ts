import { registerProcess } from "@t3tools/shared/agentProcesses";
import * as Effect from "effect/Effect";

import { registeredPorts } from "@t3tools/shared/agentProcessEnvironment";

export const registerDevProcess = Effect.fn("agentProcesses.registerDevProcess")(function* (
  pid: number,
  environment: NodeJS.ProcessEnv,
) {
  const worktreePath = environment.SIGNALBOX_PROCESS_WORKTREE;
  const sessionId = environment.SIGNALBOX_PROCESS_SESSION_ID;
  const ownerPid = Number(environment.SIGNALBOX_PROCESS_OWNER_PID);
  if (worktreePath === undefined || sessionId === undefined || !Number.isSafeInteger(ownerPid))
    return;
  yield* Effect.tryPromise(() =>
    registerProcess({
      worktreePath,
      pid,
      sessionId,
      ownerPid,
      ports: registeredPorts(environment),
      label: "dev runner",
    }),
  ).pipe(
    Effect.tapError(() =>
      Effect.logWarning("Registration failed; stopping spawned dev command", { pid, worktreePath }),
    ),
  );
});
