// signalbox: a search result opens its thread with Find already on the match (#792).
import { useEffect, useEffectEvent } from "react";

import type { ThreadFindStart } from "./threadFind";

export interface ThreadFindRequest {
  readonly threadKey: string;
  readonly query: string;
  readonly start?: ThreadFindStart;
}

// The thread's Find mounts after navigation, so the request waits for it, but
// not forever: a thread that never enables Find must not open it much later.
const REQUEST_TTL_MS = 15_000;
const THREAD_FIND_REQUEST_EVENT = "signalbox:thread-find-request";

let pending: { readonly request: ThreadFindRequest; readonly expiresAt: number } | null = null;

export function requestThreadFindAt(request: ThreadFindRequest): void {
  pending = { request, expiresAt: Date.now() + REQUEST_TTL_MS };
  window.dispatchEvent(new Event(THREAD_FIND_REQUEST_EVENT));
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
  threadKey: string | null,
  enabled: boolean,
  apply: (request: ThreadFindRequest) => void,
): void {
  const onRequest = useEffectEvent(() => {
    if (threadKey === null || !enabled) return;
    const request = takeThreadFindRequest(threadKey);
    if (request !== null) apply(request);
  });
  useEffect(() => {
    if (threadKey === null || !enabled) return;
    onRequest();
    window.addEventListener(THREAD_FIND_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(THREAD_FIND_REQUEST_EVENT, onRequest);
  }, [threadKey, enabled]);
}
