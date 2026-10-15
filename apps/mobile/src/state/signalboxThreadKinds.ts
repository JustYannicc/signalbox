/** Chat and task kinds for the thread list (Signalbox Cloud; see the web twin). Display only. */
import {
  createSignalboxThreadKindsAtoms,
  threadKindLookup,
} from "@t3tools/client-runtime/state/signalboxThreadKinds";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { effectiveThreadKind, type ThreadKind } from "@t3tools/contracts/signalboxThreadKinds";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentServerConfig } from "./entities";
import { useEnvironmentQuery } from "./query";

const signalboxThreadKinds = createSignalboxThreadKindsAtoms(connectionAtomRuntime);

/**
 * The thread's kind, or null where the environment doesn't serve kinds or hasn't sent them yet.
 * Subscribes only when the capability is advertised; one subscription per environment, shared by rows.
 */
export function useThreadKind(environmentId: EnvironmentId, threadId: ThreadId): ThreadKind | null {
  const supported =
    useEnvironmentServerConfig(environmentId)?.environment.capabilities.threadKinds === true;
  const snapshot = useEnvironmentQuery(
    supported ? signalboxThreadKinds.snapshot({ environmentId, input: {} }) : null,
  ).data;
  return snapshot === null ? null : effectiveThreadKind(threadKindLookup(snapshot)(threadId)).kind;
}
