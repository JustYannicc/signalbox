// @effect-diagnostics nodeBuiltinImport:off - canonicalizes process cwd values.
import { canonicalDirectory, isPathWithinWorktree, lexicalDirectory } from "./paths.ts";
import { sameIdentity } from "./processOps.ts";
import type { AgentProcessRecord, ProcessInspection, ProcessStatusState } from "./types.ts";

export const normalizedWorktreePath = (worktreePath: string): string => {
  try {
    return canonicalDirectory(worktreePath);
  } catch {
    return lexicalDirectory(worktreePath);
  }
};

export const describeInspection = (
  record: AgentProcessRecord,
  inspection: ProcessInspection,
): { readonly state: ProcessStatusState; readonly cwd?: string; readonly reason?: string } => {
  if (inspection.state === "missing") return { state: "exited", reason: "process has exited" };
  if (inspection.state === "unknown") return { state: "unknown", reason: inspection.reason };
  if (!sameIdentity(record.identity, inspection.identity)) {
    return { state: "reused", cwd: inspection.cwd, reason: "PID now belongs to another process" };
  }

  try {
    const root = canonicalDirectory(record.worktreePath);
    const cwd = canonicalDirectory(inspection.cwd);
    return isPathWithinWorktree(root, cwd)
      ? { state: "running", cwd }
      : { state: "cwd-mismatch", cwd, reason: "process cwd is outside its registered worktree" };
  } catch {
    return {
      state: "cwd-mismatch",
      cwd: inspection.cwd,
      reason: "worktree or process cwd cannot be verified",
    };
  }
};
