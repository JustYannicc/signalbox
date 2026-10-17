import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useSidebar } from "../ui/sidebar";
import {
  automationRoute,
  type AutomationRouteTarget,
  type AutomationView,
} from "./automationFormat";

/**
 * Opens an automation, optionally on one of its runs, from the sidebar. On
 * mobile the sidebar folds away first.
 */
export function useOpenAutomation() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  return useCallback(
    (target: AutomationRouteTarget, runId?: string | null, view?: AutomationView) => {
      if (isMobile) setOpenMobile(false);
      void navigate(automationRoute(target, runId, view));
    },
    [isMobile, navigate, setOpenMobile],
  );
}

/**
 * Automations have no list of their own (#313): they live in their folders.
 * From anywhere, this opens the palette on its automation entries, where
 * "Open automation…" reaches every one.
 */
export function openAutomationsInPalette() {
  openCommandPalette({ query: "open automation" });
}
