// @effect-diagnostics nodeBuiltinImport:off - Node preloads this before application dependencies exist.
import * as NodePath from "node:path";

import { registerProcess } from "../packages/shared/src/agentProcesses/registry.ts";
import {
  canonicalDirectory,
  isPathWithinWorktree,
} from "../packages/shared/src/agentProcesses/paths.ts";
import { registeredPorts } from "./lib/agent-process-environment.ts";

const worktreePath = process.env.SIGNALBOX_PROCESS_WORKTREE;
const sessionId = process.env.SIGNALBOX_PROCESS_SESSION_ID;
const ownerPid = Number(process.env.SIGNALBOX_PROCESS_OWNER_PID);

if (
  worktreePath !== undefined &&
  sessionId !== undefined &&
  Number.isSafeInteger(ownerPid) &&
  ownerPid > 0 &&
  isPathWithinWorktree(canonicalDirectory(worktreePath), canonicalDirectory(process.cwd()))
) {
  await registerProcess({
    worktreePath,
    pid: process.pid,
    sessionId,
    ownerPid,
    ports: registeredPorts(process.env),
    label: NodePath.basename(process.argv[1] ?? "node"),
  });
}
