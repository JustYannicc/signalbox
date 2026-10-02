// @effect-diagnostics nodeBuiltinImport:off - a synchronous path check with no Effect services to thread through.
/**
 * Threads imported from T3 Code keep their worktrees under `~/.t3/worktrees`,
 * where T3 Code's copy of the same thread still uses them. Signalbox must
 * never delete those, so `GitWorkflowService.removeWorktree` refuses any path
 * inside the T3 home. Storage cleanup only ever touches Signalbox's own
 * worktrees dir and is unaffected.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const realOrResolved = (target: string) => {
  const resolved = NodePath.resolve(target);
  try {
    return NodeFS.realpathSync(resolved);
  } catch {
    return resolved;
  }
};

const isInside = (parent: string, child: string) => {
  const relative = NodePath.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

/**
 * Whether `worktreePath` lies in T3 Code's home. A server deliberately run on
 * that home (`T3CODE_HOME=~/.t3`) owns it and is allowed through.
 */
export function isT3HomeWorktree(
  worktreePath: string,
  options: { readonly homeDirectory?: string; readonly t3HomeOverride?: string } = {},
): boolean {
  const t3Home = realOrResolved(NodePath.join(options.homeDirectory ?? NodeOS.homedir(), ".t3"));
  const override = options.t3HomeOverride ?? process.env.T3CODE_HOME;
  if (
    override !== undefined &&
    override.trim() !== "" &&
    isInside(t3Home, realOrResolved(override))
  ) {
    return false;
  }
  return isInside(t3Home, realOrResolved(worktreePath));
}

/** Pipe step for a worktree removal: fails before `self` runs when the path is T3 Code's. */
export const guardT3HomeWorktree =
  (input: { readonly cwd: string; readonly path: string }) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.suspend((): Effect.Effect<A, E | GitCommandError, R> =>
      isT3HomeWorktree(input.path)
        ? Effect.fail(
            new GitCommandError({
              operation: "GitWorkflowService.removeWorktree",
              command: "git worktree remove",
              cwd: input.cwd,
              detail:
                "This worktree belongs to T3 Code, which may still use it, so Signalbox leaves it in place. Remove it from T3 Code instead.",
            }),
          )
        : self,
    );
