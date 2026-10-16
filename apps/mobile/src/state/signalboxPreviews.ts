/** Signalbox Cloud previews: the dev servers a thread's machine serves (see the web twin). */
import {
  createSignalboxPreviewsAtoms,
  previewPortsToOffer,
} from "@t3tools/client-runtime/state/signalboxPreviews";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentServerConfig } from "./entities";
import { useEnvironmentQuery } from "./query";

export const signalboxPreviews = createSignalboxPreviewsAtoms(connectionAtomRuntime);

/** Whether the environment opens threads' dev servers through the PreviewGateway. */
export function useEnvironmentSupportsSignalboxPreviews(environmentId: EnvironmentId | null) {
  return (
    useEnvironmentServerConfig(environmentId)?.environment.capabilities.signalboxPreviews === true
  );
}

/**
 * The thread's previews to offer, and whether the agent has browsed there:
 * none and false outside Signalbox Cloud. Ports show only while a machine
 * runs; `browsed` stays once the trail has a step.
 */
export function useThreadPreviews(environmentId: EnvironmentId, threadId: ThreadId) {
  const supported = useEnvironmentSupportsSignalboxPreviews(environmentId);
  const previews = useEnvironmentQuery(
    supported ? signalboxPreviews.thread({ environmentId, input: { threadId } }) : null,
  ).data;
  const ports = useMemo(() => previewPortsToOffer(previews), [previews]);
  return { ports, browsed: previews?.browsed === true };
}
