/**
 * Thread details' "Level": the Home folder a thread lives in and the agent
 * that coordinates it there. A subagent (or fork) can't be placed on its own:
 * it works at its parent thread's level, and says so. Real threads read the
 * same placement as the Home tree (`levels/threadLevel.ts`); fixture surfaces
 * (shared chats, rooms, agents) pass their level key to `LevelSection`.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { LevelOptionsProvider, useLevelOptionsContext } from "../levels/LevelOptionsProvider";
import { levelLabel, TOP_LEVEL, type LevelKey } from "../levels/levels";
import { useThreadLevel } from "../levels/threadLevel";
import { useAssistantIdentity } from "../assistant/assistantIdentity";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

function LevelBody(props: {
  level: LevelKey;
  inheritedAs?: "subagent" | "fork" | null;
  separated?: boolean;
}) {
  const options = useLevelOptionsContext();
  const { name: assistantName } = useAssistantIdentity();
  const option = options.find((candidate) => candidate.key === props.level);
  const label = option?.label ?? levelLabel(props.level);
  const agentName =
    props.level === TOP_LEVEL ? assistantName : (option?.agentName ?? "Project agent");

  return (
    <ThreadDetailsSection
      headingId="thread-details-level-heading"
      title="Level"
      separated={props.separated ?? true}
    >
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
        {props.inheritedAs ? (
          <span className="text-muted-foreground">
            {props.inheritedAs === "subagent" ? "Subagent" : "Fork"}: works at its parent thread's
            level.
          </span>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}

function ThreadLevelBody(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const ref = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const placement = useThreadLevel(ref);
  if (!placement) return null;
  return <LevelBody level={placement.level} inheritedAs={placement.inheritedAs} />;
}

export function ThreadLevelSection(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  return (
    <LevelOptionsProvider>
      <ThreadLevelBody environmentId={props.environmentId} threadId={props.threadId} />
    </LevelOptionsProvider>
  );
}

/** The Level section for a surface that knows its level key directly. */
export function LevelSection(props: { level: LevelKey; separated?: boolean }) {
  return (
    <LevelOptionsProvider>
      <LevelBody level={props.level} separated={props.separated ?? true} />
    </LevelOptionsProvider>
  );
}
