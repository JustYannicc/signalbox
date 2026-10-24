import {
  askHtmlShellDocument,
  isAskHtmlNavigationAllowed,
  readAskHtmlNativeMessage,
} from "@t3tools/client-runtime/askHtml";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { AppText as Text } from "../../components/ui/AppText";
import { uuidv4 } from "../../lib/uuid";

const MIN_HEIGHT = 80;

/**
 * Agent HTML in a sandboxed frame inside a Signalbox-owned shell, in an isolated WebView: no
 * shared cookies or storage and no host bridge. The shell's policy blocks every navigation of
 * the view, and the WebView refuses any load but the shell and its view as a second guard. The
 * shell relays only its frame's messages, sealed with a secret the view can't read.
 */
export function AskHtmlWebView(props: {
  readonly html: string;
  readonly title: string;
  readonly maxHeight: number;
  /** Absent for previews, which can't answer. */
  readonly onAnswer?: (value: unknown) => void;
}) {
  const [ids] = useState(() => ({ nonce: uuidv4(), secret: uuidv4() }));
  const [height, setHeight] = useState(MIN_HEIGHT * 2);
  const [stopped, setStopped] = useState<"navigated" | "crashed" | null>(null);
  // A new source object would rebuild the document and reload the frame, losing its state.
  const source = useMemo(
    () => ({ html: askHtmlShellDocument(props.html, ids, "native") }),
    [props.html, ids],
  );
  if (stopped !== null) {
    return (
      <Text className="rounded-[14px] border border-dashed border-border px-3 py-2 font-sans text-sm text-foreground-muted">
        {stopped === "navigated"
          ? `${props.title} left its page, so it was stopped. Its earlier answer, if any, is kept.`
          : `${props.title} stopped working. Answer in your own words below.`}
      </Text>
    );
  }
  return (
    <View
      style={{ height }}
      className="overflow-hidden rounded-[14px] border border-border bg-card"
    >
      <WebView
        source={source}
        accessibilityLabel={props.title}
        style={{ flex: 1, backgroundColor: "transparent" }}
        // Every URL reaches the gate below: one outside the whitelist would open in the browser.
        originWhitelist={["*"]}
        incognito
        sharedCookiesEnabled={false}
        thirdPartyCookiesEnabled={false}
        cacheEnabled={false}
        allowFileAccess={false}
        allowsLinkPreview={false}
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows={false}
        nestedScrollEnabled
        // Only the shell (about:blank) and its view (about:srcdoc) ever load, in any frame.
        onShouldStartLoadWithRequest={(request) => isAskHtmlNavigationAllowed(request.url)}
        onContentProcessDidTerminate={() => setStopped("crashed")}
        onRenderProcessGone={() => setStopped("crashed")}
        onError={() => setStopped("crashed")}
        onMessage={(event: WebViewMessageEvent): void => {
          const message = readAskHtmlNativeMessage(event.nativeEvent.data, ids);
          if (message === null) return;
          if (message.type === "navigated") setStopped("navigated");
          else if (message.type === "height") {
            setHeight(Math.max(MIN_HEIGHT, Math.min(message.height, props.maxHeight)));
          } else props.onAnswer?.(message.value);
        }}
      />
    </View>
  );
}
