import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useSidebar } from "../../ui/sidebar";

/** Opens a section's or project's agent thread (`/agent/section-…`, `/agent/project-…`). */
export function useOpenHomeAgent() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  return useCallback(
    (agentId: string) => {
      if (isMobile) setOpenMobile(false);
      void navigate({ to: "/agent/$agentId", params: { agentId } });
    },
    [isMobile, navigate, setOpenMobile],
  );
}
