import { useEffect, useMemo, useState } from "react";

import { ASKS, CONTEXTS, type ContextFixture } from "./topLayerFixtures";
import { buildQueue, type Queue } from "./topLayerQueue";
import { useTopLayerStore } from "./topLayerStore";

/** Today's pipeline: open asks, minus anything answered or put off until later. */
export function useQueue(): Queue {
  const answers = useTopLayerStore((state) => state.answers);
  const intent = useTopLayerStore((state) => state.intent);
  return useMemo(
    () =>
      buildQueue({
        contexts: CONTEXTS,
        asks: ASKS,
        isOpen: (ask) => answers[ask.id] === undefined,
        intent,
      }),
    [answers, intent],
  );
}

export interface AgentDoing {
  readonly agentName: string;
  readonly doing: string;
  readonly activity: ContextFixture["activity"];
}

/**
 * Which agent the avatar is acting out right now. It cycles through the busy
 * ones every few seconds, so a glance at Now shows the work moving.
 * PLACEHOLDER: every fixture context is busy; real activity comes from runs.
 */
export function useActivityCycle(everyMs = 6000): AgentDoing | null {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setIndex((current) => current + 1), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  const context = CONTEXTS[index % CONTEXTS.length];
  return context
    ? { agentName: context.agentName, doing: context.doing, activity: context.activity }
    : null;
}
