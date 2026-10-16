"use client";

import { useAtomValue } from "@effect/atom-react";
import { browsingTabHost, browsingTabLabel, isOwnedBy } from "@t3tools/client-runtime/browsing";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { promptLinkDeepLink } from "@t3tools/shared/promptLinks";
import { memo } from "react";

import { BrowserMockup } from "~/components/preview/BrowserMockup";
import { PreviewFaviconIcon } from "~/components/preview/PreviewFaviconIcon";
import { GetSignalboxButton, OpenInAppButton } from "~/components/promptLinks/OpenInAppButtons";
import { Badge } from "~/components/ui/badge";
import { DiscoveryList, DiscoveryListRow } from "~/components/ui/discovery-list";
import {
  readThreadPreviewState,
  setActivePreviewTab,
  useThreadPreviewState,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { shownBrowsingTabId } from "./browsingPanel";
import { dispatchBrowsingCommand, threadBrowsingStateAtom } from "./threadBrowsingSync";

/**
 * A synced thread's browser on a client with no engine of its own (#585):
 * the tabs the thread keeps, which one every device shows, and the way into
 * an app that loads them. Picking a tab switches it on every device. An
 * agent's tabs run in its own cloud browser; they list here, marked as its.
 */
export function ThreadBrowsingWebView({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const state = useAtomValue(threadBrowsingStateAtom(scopedThreadKey(threadRef)));
  const tabs = state?.record.tabs;
  const activeTabId = shownBrowsingTabId(state, useThreadPreviewState(threadRef).activeTabId);
  const count = tabs?.length ?? 0;
  const deepLink = promptLinkDeepLink(
    `/${encodeURIComponent(threadRef.environmentId)}/${encodeURIComponent(threadRef.threadId)}`,
  );

  return (
    <div className="scrollbar-gutter-both flex h-full min-h-0 overflow-y-auto px-5 py-8">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-sm font-medium text-foreground">Pages open in the Signalbox app</h2>
          <p className="text-sm text-muted-foreground">
            {count === 0
              ? "Pages this thread opens load in the desktop app and on your phone, signed in as you on each."
              : "This thread's tabs load in the desktop app and on your phone, signed in as you on each."}
            {count > 1 ? " Pick a tab to show it on all of them." : null}
          </p>
        </div>
        {tabs && count > 0 ? (
          <DiscoveryList>
            {tabs.map((tab) => (
              <BrowsingTabRow
                key={tab.id}
                threadRef={threadRef}
                tabId={tab.id}
                url={tab.url}
                title={tab.title}
                agent={tab.owner._tag === "Agent"}
                local={isOwnedBy(tab, state?.you ?? null)}
                active={tab.id === activeTabId}
              />
            ))}
          </DiscoveryList>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <OpenInAppButton deepLink={deepLink} />
          <GetSignalboxButton newTab />
        </div>
      </div>
    </div>
  );
}

/** One record tab. Memoized: positions land every few seconds and change none of this. */
const BrowsingTabRow = memo(function BrowsingTabRow(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly url: string | null;
  readonly title: string;
  /** An agent drives it, in its own cloud browser. */
  readonly agent: boolean;
  /** This person drives it, so it has a page on their devices and a tab in the panel. */
  readonly local: boolean;
  readonly active: boolean;
}) {
  const { threadRef, tabId, url, title, agent, local, active } = props;
  const label = browsingTabLabel({ url, title });
  const host = browsingTabHost(url) ?? url ?? "New tab";
  const activate = () => void dispatchBrowsingCommand(threadRef, { _tag: "Activate", tabId });
  const show = () => {
    if (!local) return activate();
    const surfaceId = `browser:${tabId}`;
    const panel = useRightPanelStore.getState();
    const surfaces = panel.byThreadKey[scopedThreadKey(threadRef)]?.surfaces ?? [];
    if (surfaces.some((surface) => surface.id === surfaceId)) {
      panel.activateSurface(threadRef, surfaceId);
    }
    // The thread sync sends the switch, so the desktop and phone follow; a tab
    // this device already shows (while the thread shows an agent's) goes directly.
    if (readThreadPreviewState(threadRef).activeTabId === tabId) {
      if (!active) activate();
      return;
    }
    setActivePreviewTab(threadRef, tabId);
  };
  return (
    <DiscoveryListRow
      aria-current={active ? "true" : undefined}
      icon={
        url === null ? (
          <BrowserMockup className="size-7 shrink-0" />
        ) : (
          <PreviewFaviconIcon threadRef={threadRef} url={url} />
        )
      }
      title={label}
      description={label === host ? (url ?? host) : host}
      action={
        agent || active ? (
          <span className="flex shrink-0 items-center gap-1.5">
            {agent ? (
              <Badge variant="outline" size="sm">
                Agent
              </Badge>
            ) : null}
            {active ? (
              <Badge variant="secondary" size="sm">
                Showing
              </Badge>
            ) : null}
          </span>
        ) : null
      }
      onClick={show}
    />
  );
});
