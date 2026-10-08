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

/** The thread's previews to offer; none outside Signalbox Cloud or while no machine runs. */
export function useThreadPreviewPorts(environmentId: EnvironmentId, threadId: ThreadId) {
  const supported =
    useEnvironmentServerConfig(environmentId)?.environment.capabilities.signalboxPreviews === true;
  const previews = useEnvironmentQuery(
    supported ? signalboxPreviews.thread({ environmentId, input: { threadId } }) : null,
  ).data;
  return useMemo(() => previewPortsToOffer(previews), [previews]);
}
