import { restorePagePositionScript } from "@t3tools/client-runtime/browsing/page-position";
import type {
  BrowsingMember,
  BrowsingPosition,
  BrowsingTab,
} from "@t3tools/contracts/signalboxBrowsing";
import {
  type Ref,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { View } from "react-native";
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";
import type { WebViewNativeEvent } from "react-native-webview/lib/WebViewTypes";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { LoadingStrip } from "../../components/ui/LoadingStrip";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import type { BrowsingDispatch } from "../../state/browsing";
import { AddressBar } from "./AddressBar";
import {
  browsingPageScript,
  navigateCommand,
  parsePageMessage,
  type PendingReport,
  positionCommand,
  positionToRestore,
  settleReports,
  urlToFollow,
} from "./syncedBrowsing";

/** How long scrolling has to settle before the thread hears where the reader is. */
const POSITION_REPORT_DELAY_MS = 1_500;
const POSITION_CHECK_INTERVAL_MS = 500;

const WEB_SCHEMES = /^(https?|about|blob|data):/i;

interface LocalNavigation {
  readonly url: string | null;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

/**
 * One of your synced tabs in this device's own WebView. It loads the record's
 * page, reports where it went and where you read to, restores where another of
 * your devices left it, and follows navigations made there. Back, forward and
 * reload stay on this device. Mounted once per tab, so switching tabs starts
 * fresh. Only for tabs you own (`browsingTabEngine`): an agent's never load here.
 */
export function SyncedBrowserTab(props: {
  readonly tab: BrowsingTab;
  readonly you: BrowsingMember | null;
  /** Off while the panel is covered or the app is in the background. */
  readonly live: boolean;
  readonly background: string;
  readonly report: BrowsingDispatch;
}) {
  const { tab, you, live, report } = props;
  const webView = useRef<WebView<object>>(null);
  const progress = useRef<PageProgress>(null);
  const [source, setSource] = useState(() => (tab.url === null ? null : { uri: tab.url }));
  const [local, setLocal] = useState<LocalNavigation>({
    url: tab.url,
    canGoBack: false,
    canGoForward: false,
  });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageReady, setPageReady] = useState(false);

  // Bookkeeping for the page in the WebView, not anything rendered.
  /** Navigations this device reported that the record hasn't shown back yet, oldest first. */
  const pending = useRef<ReadonlyArray<PendingReport>>([]);
  const previousRecordUrl = useRef(tab.url);
  const failed = useRef(false);
  const restored = useRef<BrowsingPosition | null>(null);
  const readerScrolled = useRef(false);
  const unsentPosition = useRef<{
    readonly position: BrowsingPosition;
    readonly pageUrl: string | null;
    readonly at: number;
  } | null>(null);

  const sendPosition = (settledOnly: boolean) => {
    const latest = unsentPosition.current;
    if (latest === null) return;
    if (settledOnly && Date.now() - latest.at < POSITION_REPORT_DELAY_MS) return;
    unsentPosition.current = null;
    const command = positionCommand(
      tab,
      you,
      latest.position,
      latest.pageUrl,
      pending.current.at(-1) ?? null,
    );
    if (command !== null) void report(command);
  };
  const sendSettledPosition = useEffectEvent(() => sendPosition(true));
  const sendAnyPosition = useEffectEvent(() => sendPosition(false));
  // Sent once scrolling settles, and right away when the panel goes out of sight or the tab closes.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(sendSettledPosition, POSITION_CHECK_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      sendAnyPosition();
    };
  }, [live]);

  const reportPage = (url: string | null | undefined, title: string | null | undefined) => {
    const command = navigateCommand(tab, you, { url, title }, pending.current.at(-1) ?? null);
    if (command?._tag !== "Navigate") return;
    const sent = { url: command.url, title: command.title, at: Date.now() };
    pending.current = [...pending.current.slice(-7), sent];
    void report(command).then((result) => {
      if (result._tag === "Failure") {
        pending.current = pending.current.filter((entry) => entry !== sent);
      }
    });
  };

  const load = (url: string) => {
    setLoadError(null);
    setLocal((current) => ({ ...current, url }));
    // The same source again wouldn't reload, so ask the page to go there.
    if (source?.uri === url) {
      webView.current?.injectJavaScript(`window.location.assign(${JSON.stringify(url)});\ntrue;`);
      return;
    }
    setSource({ uri: url });
  };

  // Someone else navigated this tab: go there too, unless it's where this device already is.
  const follow = useEffectEvent((recordUrl: string | null) => {
    const next = urlToFollow({
      tab,
      you,
      previousRecordUrl: previousRecordUrl.current,
      reported: pending.current,
      viewUrl: local.url,
    });
    if (previousRecordUrl.current !== recordUrl) {
      pending.current = settleReports(pending.current, recordUrl, Date.now());
    }
    previousRecordUrl.current = recordUrl;
    if (next !== null) load(next);
  });
  useEffect(() => follow(tab.url), [tab.url]);

  // Once the page loaded, and for positions arriving later until the reader scrolls.
  useEffect(() => {
    if (!pageReady || readerScrolled.current) return;
    const position = positionToRestore(tab, you, restored.current);
    if (position === null) return;
    restored.current = position;
    webView.current?.injectJavaScript(`${restorePagePositionScript(position)};\ntrue;`);
  }, [pageReady, tab, you]);

  const onNavigation = (event: WebViewNativeEvent) =>
    setLocal({ url: event.url, canGoBack: event.canGoBack, canGoForward: event.canGoForward });
  const onLoadStart = () => {
    sendPosition(false);
    failed.current = false;
    restored.current = null;
    readerScrolled.current = false;
    setPageReady(false);
    setLoadError(null);
    progress.current?.set(0.05);
  };
  const onLoadEnd = (event: { nativeEvent: WebViewNativeEvent }) => {
    progress.current?.set(0);
    onNavigation(event.nativeEvent);
    if (failed.current) return;
    setPageReady(true);
    reportPage(event.nativeEvent.url, event.nativeEvent.title);
  };
  const onNavigationStateChange = (event: WebViewNavigation) => {
    onNavigation(event);
    // Single-page apps change address without a load.
    if (!event.loading && !failed.current) reportPage(event.url, event.title);
  };
  const onMessage = (event: WebViewMessageEvent) => {
    const message = parsePageMessage(event.nativeEvent.data, tab.id);
    if (message === null) return;
    // The engine's URL, never the page's say-so.
    if (message.kind === "page") return reportPage(event.nativeEvent.url, message.title);
    readerScrolled.current = true;
    unsentPosition.current = {
      position: message.position,
      pageUrl: event.nativeEvent.url,
      at: Date.now(),
    };
  };

  const injectedJavaScript = useMemo(() => browsingPageScript(tab.id), [tab.id]);

  return (
    <>
      <AddressBar
        url={local.url ?? ""}
        canGoBack={local.canGoBack}
        canGoForward={local.canGoForward}
        canReload={source !== null}
        editable
        autoFocus={tab.url === null}
        onBack={() => webView.current?.goBack()}
        onForward={() => webView.current?.goForward()}
        onReload={() => {
          setLoadError(null);
          webView.current?.reload();
        }}
        onNavigate={load}
      />
      <View className="relative flex-1" style={{ backgroundColor: props.background }}>
        <PageLoadingStrip ref={progress} />
        {loadError !== null ? (
          <View className="border-b border-border px-4 py-2">
            <Text className="text-xs font-t3-bold text-foreground">This page didn't load</Text>
            <Text className="mt-0.5 text-xs leading-snug text-foreground-muted">{loadError}</Text>
          </View>
        ) : null}
        {source === null ? (
          <View className="flex-1 items-center justify-center px-8">
            <Text textRole="body" className="text-center text-foreground-muted">
              Search or enter an address to open a page in this tab.
            </Text>
          </View>
        ) : (
          <WebView<object>
            ref={webView}
            source={source}
            accessibilityLabel={tab.title || "Browser tab"}
            style={{ flex: 1, backgroundColor: "transparent" }}
            originWhitelist={["*"]}
            injectedJavaScript={injectedJavaScript}
            allowsBackForwardNavigationGestures
            allowsInlineMediaPlayback
            allowsFullscreenVideo
            setSupportMultipleWindows={false}
            startInLoadingState
            renderLoading={() => (
              <View className="absolute inset-0 items-center justify-center">
                <AppActivityIndicator />
              </View>
            )}
            onShouldStartLoadWithRequest={(request) => {
              if (WEB_SCHEMES.test(request.url)) return true;
              // mailto:, tel:, app links: the phone's own apps handle them.
              if (request.isTopFrame !== false) {
                void tryOpenExternalUrl(request.url, "synced-browser");
              }
              return false;
            }}
            onLoadStart={onLoadStart}
            onLoadProgress={(event) => progress.current?.set(event.nativeEvent.progress)}
            onLoadEnd={onLoadEnd}
            onError={(event) => {
              failed.current = true;
              progress.current?.set(0);
              setLoadError(
                event.nativeEvent.description || "Check the address and your connection.",
              );
            }}
            onNavigationStateChange={onNavigationStateChange}
            onMessage={onMessage}
            onContentProcessDidTerminate={() => webView.current?.reload()}
            onRenderProcessGone={() => webView.current?.reload()}
          />
        )}
      </View>
    </>
  );
}

interface PageProgress {
  readonly set: (progress: number) => void;
}

/** Holds the load progress itself, so progress ticks repaint the strip and not the WebView. */
function PageLoadingStrip({ ref }: { readonly ref: Ref<PageProgress> }) {
  const [value, setValue] = useState(0);
  useImperativeHandle(ref, () => ({ set: setValue }), []);
  return value > 0 && value < 1 ? <LoadingStrip progress={value} /> : null;
}
