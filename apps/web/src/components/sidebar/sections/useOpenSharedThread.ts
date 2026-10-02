import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { newDraftThreadId } from "../../multiplayer/multiplayerModel";
import type { ThreadKind } from "./threadKind";
import { useSidebar } from "../../ui/sidebar";

/**
 * Opens a team or loose item (`/shared/$threadId`), or a fresh draft in a
 * container. Drafts get their own id; visibility follows the container default.
 */
export function useOpenSharedThread() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const open = useCallback(
    (threadId: string, search: { project?: string; kind?: ThreadKind } = {}) => {
      if (isMobile) setOpenMobile(false);
      void navigate({ to: "/shared/$threadId", params: { threadId }, search });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const openNew = useCallback(
    (kind: ThreadKind, project: string) => open(newDraftThreadId(), { project, kind }),
    [open],
  );
  return { open, openNew };
}
