/** A thread's synced browser tabs in Signalbox Cloud (#585; see the web twin). */
import { useAtomValue } from "@effect/atom-react";
import { createBrowsingAtoms } from "@t3tools/client-runtime/state/browsing";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { BrowsingCommand } from "@t3tools/contracts/signalboxBrowsing";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentServerConfig } from "./entities";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

export const browsing = createBrowsingAtoms(connectionAtomRuntime);

export function useThreadBrowsingSupported(environmentId: EnvironmentId): boolean {
  return (
    useEnvironmentServerConfig(environmentId)?.environment.capabilities.threadBrowsing === true
  );
}

/**
 * The thread's browsing state; `data` is null outside Signalbox Cloud and
 * until the first snapshot. Every caller for a thread shares one subscription.
 */
export function useThreadBrowsing(environmentId: EnvironmentId, threadId: ThreadId) {
  const supported = useThreadBrowsingSupported(environmentId);
  const query = useEnvironmentQuery(
    supported ? browsing.thread({ environmentId, input: { threadId } }) : null,
  );
  return { supported, ...query };
}

const NO_TABS = Atom.make(0).pipe(Atom.withLabel("mobile-browsing:no-tabs"));

// A number, so scrolling and titles on other devices don't re-render the thread screen.
const tabCount = Atom.family((thread: ReturnType<typeof browsing.thread>) =>
  Atom.map(thread, (result) =>
    Option.match(AsyncResult.value(result), {
      onNone: () => 0,
      onSome: (state) => state.record.tabs.length,
    }),
  ),
);

/** How many synced tabs the thread has; 0 outside Signalbox Cloud. */
export function useThreadBrowsingTabCount(environmentId: EnvironmentId, threadId: ThreadId) {
  const supported = useThreadBrowsingSupported(environmentId);
  return useAtomValue(
    supported ? tabCount(browsing.thread({ environmentId, input: { threadId } })) : NO_TABS,
  );
}

/**
 * Sends one change to the thread's record. `report` is for what the WebView
 * reports on its own (navigations, scrolling): a tab closing under it is
 * expected, so those failures stay quiet.
 */
export function useBrowsingDispatch(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  kind: "action" | "report",
) {
  const dispatch = useAtomCommand(
    browsing.dispatch,
    kind === "action"
      ? "browser tab change"
      : { label: "browser tab report", reportFailure: false },
  );
  return useCallback(
    (command: BrowsingCommand) => dispatch({ environmentId, input: { threadId, command } }),
    [dispatch, environmentId, threadId],
  );
}

export type BrowsingDispatch = ReturnType<typeof useBrowsingDispatch>;
