import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useSidebar } from "../ui/sidebar";
import { automationRoute, type AutomationRouteTarget } from "./automationFormat";

/**
 * Opens an automation, optionally on one of its runs, from the sidebar; with
 * no target, the overview. On mobile the sidebar folds away first.
 */
export function useOpenAutomation() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  return useCallback(
    (target?: AutomationRouteTarget, runId?: string | null) => {
      if (isMobile) setOpenMobile(false);
      if (target) void navigate(automationRoute(target, runId));
      else void navigate({ to: "/automations" });
    },
    [isMobile, navigate, setOpenMobile],
  );
}

/** Opens the overview, from anywhere. */
export function useOpenAutomations() {
  const navigate = useNavigate();
  return useCallback(async () => {
    await navigate({ to: "/automations" });
  }, [navigate]);
}
