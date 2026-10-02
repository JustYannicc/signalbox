/**
 * Drill-down from a hand-off, trace node or carried-over item to the real
 * thing: a shared chat, an agent's page, an automation. Placeholder threads
 * with no counterpart yet say so instead.
 */
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { toastManager } from "../ui/toast";
import type { TraceNodeFixture } from "./assistantFixtures";
import { agentIdForNode } from "./AssistantGlyphs";

export function canOpenNode(node: TraceNodeFixture): boolean {
  return node.kind !== "thread" || node.sharedThreadId !== undefined;
}

export function useOpenNode() {
  const navigate = useNavigate();
  return useCallback(
    (node: TraceNodeFixture) => {
      if (node.kind === "assistant") return void navigate({ to: "/assistant" });
      if (node.kind === "automations") return void navigate({ to: "/automations" });
      if (node.kind === "trigger") {
        const automationId = node.id.replace(/^trigger:/, "");
        return void navigate({ to: "/automations/$automationId", params: { automationId } });
      }
      if (node.kind !== "thread") {
        return void navigate({
          to: "/agent/$agentId",
          params: { agentId: agentIdForNode(node) },
        });
      }
      if (node.sharedThreadId) {
        return void navigate({
          to: "/shared/$threadId",
          params: { threadId: node.sharedThreadId },
        });
      }
      toastManager.add({
        id: "assistant-open-thread",
        type: "info",
        title: `“${node.name}” is a placeholder`,
        description: "This thread only exists in the prototype data.",
        timeout: 2500,
      });
    },
    [navigate],
  );
}
