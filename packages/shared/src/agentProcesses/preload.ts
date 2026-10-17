// @effect-diagnostics nodeBuiltinImport:off - Node preloads this before application dependencies exist.
import * as NodePath from "node:path";

import { registerProcess } from "./registry.ts";
import { canonicalDirectory, isPathWithinWorktree } from "./paths.ts";
import { registeredPorts } from "./environment.ts";

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
  // A descendant must register before executing so it cannot outlive its session
  // or start untracked while its worktree is being removed.
  await registerProcess({
    worktreePath,
    pid: process.pid,
    sessionId,
    ownerPid,
    ports: registeredPorts(process.env),
    label: NodePath.basename(process.argv[1] ?? "node"),
  });
}
