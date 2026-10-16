/** Signalbox Cloud: the agent's browser, mirrored live, and its trail of steps (see the web twin). */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createSignalboxAgentBrowserAtoms } from "@t3tools/client-runtime/state/signalboxAgentBrowser";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useThreadShell } from "./entities";
import { useEnvironmentQuery } from "./query";
import { useEnvironmentSupportsSignalboxPreviews } from "./signalboxPreviews";

export const signalboxAgentBrowser = createSignalboxAgentBrowserAtoms(connectionAtomRuntime);

/**
 * The thread's browser trail, oldest first; empty outside Signalbox Cloud.
 * Read only where it shows (the browser panel). Read again whenever a run
 * changes state, since a step lands in it as the agent works.
 */
export function useAgentBrowserTrail(environmentId: EnvironmentId, threadId: ThreadId) {
  const supported = useEnvironmentSupportsSignalboxPreviews(environmentId);
  const query = useEnvironmentQuery(
    supported ? signalboxAgentBrowser.trail({ environmentId, input: { threadId } }) : null,
  );
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const run = useThreadShell(supported ? threadRef : null)?.latestRun;
  const runKey = run ? `${run.runId}:${run.status}` : null;
  const { refresh } = query;
  const seenRunKey = useRef(runKey);
  useEffect(() => {
    if (seenRunKey.current === runKey) return;
    seenRunKey.current = runKey;
    refresh();
  }, [refresh, runKey]);
  return { supported, steps: query.data?.steps ?? null, error: query.error, refresh };
}
