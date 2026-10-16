"use client";

import { type BrowsingState, isOwnedBy } from "@t3tools/client-runtime/browsing";
import {
  parseCapturedPosition,
  restorePagePositionScript,
} from "@t3tools/client-runtime/browsing/page-position";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { DesktopPreviewTabState, ScopedThreadRef } from "@t3tools/contracts";
import type { BrowsingPosition, BrowsingTab } from "@t3tools/contracts/signalboxBrowsing";
import { type RefObject, useEffect, useEffectEvent, useRef } from "react";

import { withDesktopTab } from "~/browser/desktopTabLifetime";
import { previewBridge } from "~/components/preview/previewBridge";
import { readThreadPreviewState, updatePreviewServerSnapshot } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironmentSupportsThreadBrowsing } from "~/state/browsing";

import {
  captureIfReadScript,
  engineSentTo,
  engineVisited,
  initialEngineNavigation,
  navigationToFollow,
  positionToReport,
  positionToRestore,
  readerScrollTrackerScript,
} from "./browsingEngine";
import { dispatchBrowsingCommand, threadBrowsingStateAtom } from "./threadBrowsingSync";

/** How often a visible page is asked whether the reader scrolled it. */
const CAPTURE_INTERVAL_MS = 3_000;

interface EngineWebview extends HTMLElement {
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
  getURL: () => string;
}

interface Props {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly runtimeTabId: string;
  readonly initialUrl: string | null;
  readonly webviewRef: RefObject<HTMLElement | null>;
  /** Bumps when crash recovery replaces the `<webview>` element. */
  readonly webviewGeneration: number;
  /** Whether a person sees the page. */
  readonly visible: boolean;
}

/**
 * Loads a synced thread's tab (#585) that this person owns into this
 * desktop's `<webview>`: goes where their other device took the tab, puts the
 * page where they read to, and reports where it's read to here. Renders nothing. Only for environments
 * that advertise `capabilities.threadBrowsing`.
 */
export function BrowsingTabEngine(props: Props) {
  const synced = useEnvironmentSupportsThreadBrowsing(props.threadRef.environmentId);
  return synced ? <SyncedTabEngine {...props} /> : null;
}

function SyncedTabEngine({
  threadRef,
  tabId,
  runtimeTabId,
  initialUrl,
  webviewRef,
  webviewGeneration,
  visible,
}: Props) {
  const threadKey = scopedThreadKey(threadRef);
  const navigationRef = useRef(initialEngineNavigation(initialUrl));
  const recordUrlRef = useRef(initialUrl);
  /** Restore once the next load finishes: the first one, and each one the record sent here. */
  const restoreArmedRef = useRef(true);
  const restoredPositionRef = useRef<BrowsingPosition | undefined>(undefined);

  const webview = () => webviewRef.current as EngineWebview | null;
  const webviewUrl = (element: EngineWebview) => {
    try {
      return element.getURL();
    } catch {
      return null;
    }
  };
  const recordTab = (): { state: BrowsingState; tab: BrowsingTab } | null => {
    const state = appAtomRegistry.get(threadBrowsingStateAtom(threadKey));
    const tab = state?.record.tabs.find((candidate) => candidate.id === tabId);
    return state && tab ? { state, tab } : null;
  };
  const restore = (state: BrowsingState, tab: BrowsingTab) => {
    const element = webview();
    const position = element ? positionToRestore(tab, state.you, webviewUrl(element)) : null;
    if (!element || position === null) return;
    restoredPositionRef.current = tab.position;
    element.executeJavaScript(restorePagePositionScript(position)).catch(() => undefined);
  };

  // Where this engine really is, so its own reports coming back aren't followed.
  const onEngineState = useEffectEvent((changedTabId: string, state: DesktopPreviewTabState) => {
    if (changedTabId !== runtimeTabId) return;
    const status = state.navStatus;
    if (status.kind !== "Success" && status.kind !== "LoadFailed") return;
    navigationRef.current = engineVisited(navigationRef.current, status.url, Date.now());
    // The record only knows where a tab is; a failed load is this device's to show.
    const session = readThreadPreviewState(threadRef).sessions[tabId];
    if (!session || (status.kind === "Success" && session.navStatus._tag !== "LoadFailed")) return;
    updatePreviewServerSnapshot(threadRef, {
      ...session,
      navStatus:
        status.kind === "LoadFailed"
          ? {
              _tag: "LoadFailed",
              url: status.url,
              title: status.title,
              code: status.code,
              description: status.description,
            }
          : { _tag: "Success", url: status.url, title: status.title },
      updatedAt: new Date().toISOString(),
    });
  });
  useEffect(
    () => previewBridge?.onStateChange((changedTabId, state) => onEngineState(changedTabId, state)),
    [],
  );

  // Someone else moved the tab or read on.
  const onRecord = useEffectEvent((state: BrowsingState | null) => {
    const tab = state?.record.tabs.find((candidate) => candidate.id === tabId);
    // Only the owner drives a tab; this device never loads one it doesn't own.
    if (!state || !tab || !isOwnedBy(tab, state.you)) return;
    const target = navigationToFollow({
      recordUrl: tab.url,
      previousRecordUrl: recordUrlRef.current,
      navigation: navigationRef.current,
      now: Date.now(),
    });
    recordUrlRef.current = tab.url;
    const bridge = previewBridge;
    if (target !== null && bridge) {
      navigationRef.current = engineSentTo(navigationRef.current, target);
      restoreArmedRef.current = true;
      withDesktopTab(runtimeTabId, () => bridge.navigate(runtimeTabId, target));
      return;
    }
    // Out of sight, follow their reading so the page is there when this device looks.
    if (!visible && tab.position !== restoredPositionRef.current) restore(state, tab);
  });
  useEffect(
    () =>
      appAtomRegistry.subscribe(threadBrowsingStateAtom(threadKey), (state) => onRecord(state), {
        immediate: true,
      }),
    [threadKey],
  );

  const onLoaded = useEffectEvent(() => {
    if (!restoreArmedRef.current) return;
    restoreArmedRef.current = false;
    const current = recordTab();
    if (current) restore(current.state, current.tab);
  });
  useEffect(() => {
    const element = webviewRef.current;
    if (!element) return;
    const loaded = () => onLoaded();
    // Each page load gets a fresh tracker of the reader's own scrolling.
    const track = () => {
      (element as EngineWebview)
        .executeJavaScript(readerScrollTrackerScript)
        .catch(() => undefined);
    };
    element.addEventListener("dom-ready", track);
    element.addEventListener("did-finish-load", loaded);
    return () => {
      element.removeEventListener("dom-ready", track);
      element.removeEventListener("did-finish-load", loaded);
    };
  }, [webviewGeneration, webviewRef]);

  // Report where the reader scrolled to while they read, and once more when they look away.
  // A page nobody scrolled by hand (feeds, anchors, restores) reports nothing.
  const capture = useEffectEvent(async () => {
    const element = webview();
    if (!element) return;
    const url = webviewUrl(element);
    const raw = await element.executeJavaScript(captureIfReadScript).catch(() => null);
    if (raw === null) return;
    const current = recordTab();
    const command = positionToReport(
      current?.state.you ?? null,
      current?.tab,
      url,
      parseCapturedPosition(raw),
    );
    if (command !== null) void dispatchBrowsingCommand(threadRef, command);
  });
  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void capture();
    }, CAPTURE_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      void capture();
    };
  }, [visible, webviewGeneration]);

  return null;
}
