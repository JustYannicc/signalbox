/**
 * Hands a fork page's project controls to the real thread view: opens the
 * bound project's most recent thread (or its draft, via the usual new-thread
 * path) and flips the same terminal / right panel stores `ChatView` reads, so
 * it lands with that thing already open.
 */
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadShells } from "../../state/entities";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { buildThreadRouteParams } from "../../threadRoutes";

export type ProjectThreadTarget = "thread" | "terminal" | "right-panel";

export function useOpenInProjectThread(project: EnvironmentProject | null) {
  const threads = useThreadShells();
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");

  return useCallback(
    async (target: ProjectThreadTarget) => {
      if (!project) return;
      const recent = threads
        .filter(
          (thread) =>
            thread.environmentId === project.environmentId &&
            thread.projectId === project.id &&
            thread.archivedAt === null,
        )
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

      const prepare = (ref: ScopedThreadRef, worktreePath: string | null) => {
        if (target === "right-panel") useRightPanelStore.getState().show(ref);
        if (target !== "terminal") return;
        // Same as ChatView's terminal toggle: reopen the drawer, or start its first terminal.
        const store = useTerminalUiStateStore.getState();
        const state = selectThreadTerminalUiState(store.terminalUiStateByThreadKey, ref);
        if (state.terminalIds.length > 0) {
          store.setTerminalOpen(ref, true);
          return;
        }
        const terminalId = nextTerminalId(state.terminalIds);
        store.ensureTerminal(ref, terminalId, { open: true });
        void openTerminal({
          environmentId: ref.environmentId,
          input: {
            threadId: ref.threadId,
            terminalId,
            cwd: projectScriptCwd({ project: { cwd: project.workspaceRoot }, worktreePath }),
            ...(worktreePath !== null ? { worktreePath } : {}),
            env: projectScriptRuntimeEnv({
              project: { cwd: project.workspaceRoot },
              worktreePath,
            }),
          },
        });
      };

      if (recent) {
        const ref = scopeThreadRef(recent.environmentId, recent.id);
        prepare(ref, recent.worktreePath);
        await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
        return;
      }
      const draft = await handleNewThread(scopeProjectRef(project.environmentId, project.id));
      if (draft) prepare(scopeThreadRef(project.environmentId, draft.threadId), null);
    },
    [handleNewThread, navigate, openTerminal, project, threads],
  );
}
