// signalbox: a search result opens its thread with Find already on the match (#792).
import { useEffect, useEffectEvent } from "react";

import type { ThreadFindStart } from "./thread-find-model";

export interface ThreadFindRequest {
  readonly threadKey: string;
  readonly query: string;
  readonly start?: ThreadFindStart;
}

// The thread screen mounts after navigation, so the request waits for it, but
// not forever: a thread that never enables Find must not open it much later.
const REQUEST_TTL_MS = 15_000;

let pending: { readonly request: ThreadFindRequest; readonly expiresAt: number } | null = null;
const listeners = new Set<() => void>();

export function requestThreadFindAt(request: ThreadFindRequest): void {
  pending = { request, expiresAt: Date.now() + REQUEST_TTL_MS };
  for (const listener of listeners) listener();
}

function takeThreadFindRequest(threadKey: string): ThreadFindRequest | null {
  if (pending === null) return null;
  if (pending.expiresAt < Date.now()) {
    pending = null;
    return null;
  }
  if (pending.request.threadKey !== threadKey) return null;
  const { request } = pending;
  pending = null;
  return request;
}

/** Applies a waiting request once this thread's Find can open. */
export function usePendingThreadFindRequest(
  threadKey: string,
  enabled: boolean,
  apply: (request: ThreadFindRequest) => void,
): void {
  const onRequest = useEffectEvent(() => {
    if (!enabled) return;
    const request = takeThreadFindRequest(threadKey);
    if (request !== null) apply(request);
  });
  useEffect(() => {
    if (!threadKey || !enabled) return;
    onRequest();
    listeners.add(onRequest);
    return () => {
      listeners.delete(onRequest);
    };
  }, [threadKey, enabled]);
}
