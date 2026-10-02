/**
 * Timeline annotations for a real (solo) thread, so it reads like a shared
 * chat: your turns carry your avatar and name on the right, the agent's carry
 * the harness avatar and model name on the left. Placeholder until messages
 * record which model answered: every turn shows the thread's current model.
 */
import { useMemo } from "react";

import type { TimelineAnnotations } from "../chat/timelineAnnotations";
import { currentPerson } from "./teamThreads";
import { HarnessMessageHeader, PersonMessageHeader } from "./TimelineHeaders";

export function useThreadTimelineAnnotations(input: {
  /** Driver kind, e.g. "codex". */
  provider: string | null;
  modelSlug: string | null;
  models: ReadonlyArray<{ readonly slug: string; readonly name: string }> | undefined;
}): TimelineAnnotations {
  const { provider, modelSlug, models } = input;
  const modelName =
    (modelSlug ? models?.find((model) => model.slug === modelSlug)?.name : undefined) ?? modelSlug;
  return useMemo(
    () => ({
      userMessageHeader: () => <PersonMessageHeader person={currentPerson} />,
      assistantMessageHeader: () =>
        provider && modelName ? (
          <HarnessMessageHeader provider={provider} model={modelName} />
        ) : null,
    }),
    [modelName, provider],
  );
}
