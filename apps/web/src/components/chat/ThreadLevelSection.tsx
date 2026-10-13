/**
 * Thread details' "Level": the Home folder a thread lives in and the agent
 * that coordinates it there. A subagent (or fork) can't be placed on its own:
 * it works at its parent thread's level, and says so. Reads the same
 * placement as the Home tree (`levels/threadLevel.ts`).
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { LevelOptionsProvider, useLevelOptionsContext } from "../levels/LevelOptionsProvider";
import { levelLabel, TOP_LEVEL } from "../levels/levels";
import { useThreadLevel } from "../levels/threadLevel";
import { useAssistantIdentity } from "../assistant/assistantIdentity";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

function ThreadLevelBody(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const ref = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const placement = useThreadLevel(ref);
  const options = useLevelOptionsContext();
  const { name: assistantName } = useAssistantIdentity();
  if (!placement) return null;
  const option = options.find((candidate) => candidate.key === placement.level);
  const label = option?.label ?? levelLabel(placement.level);
  const agentName =
    placement.level === TOP_LEVEL ? assistantName : (option?.agentName ?? "Project agent");

  return (
    <ThreadDetailsSection headingId="thread-details-level-heading" title="Level">
      <div className="flex flex-col gap-0.5 px-1.5 text-xs">
        <span className="text-foreground">{label}</span>
        <span className="truncate text-muted-foreground">
          Coordinated by{" "}
          {option?.agentId ? (
            <Link
              to="/agent/$agentId"
              params={{ agentId: option.agentId }}
              search={{}}
              className="text-foreground underline-offset-2 hover:underline"
            >
              {agentName}
            </Link>
          ) : (
            agentName
          )}
        </span>
        {placement.inheritedAs ? (
          <span className="text-muted-foreground">
            {placement.inheritedAs === "subagent" ? "Subagent" : "Fork"}: works at its parent
            thread's level.
          </span>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}

export function ThreadLevelSection(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  return (
    <LevelOptionsProvider>
      <ThreadLevelBody environmentId={props.environmentId} threadId={props.threadId} />
    </LevelOptionsProvider>
  );
}
