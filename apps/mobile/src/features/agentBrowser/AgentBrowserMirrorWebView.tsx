import {
  AGENT_BROWSER_MIRROR_NOTHING_DELIVERED,
  planAgentBrowserMirrorDelivery,
  type AgentBrowserMirrorContent,
} from "@t3tools/client-runtime/state/signalboxAgentBrowserFrame";
import {
  parseAgentBrowserMirrorPageMessage,
  type AgentBrowserMirrorHostMessage,
} from "@t3tools/client-runtime/state/signalboxAgentBrowserMirror";
import type { AgentBrowserDrivingInput } from "@t3tools/contracts/signalboxPreviews";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { agentBrowserMirrorScript, isAgentBrowserMirrorPage } from "./agentBrowserMirrorBridge";

/**
 * The shared mirror page (`/agent-browser.html` on the environment's origin)
 * in a WebView. Sends it the page's events as they arrive, each batch once,
 * and everything again whenever the page (re)loads.
 */
export function AgentBrowserMirrorWebView(props: {
  readonly pageUrl: string;
  readonly content: AgentBrowserMirrorContent;
  readonly interactive: boolean;
  readonly background: string | undefined;
  readonly onInput: (input: AgentBrowserDrivingInput) => void;
  readonly onActivity: () => void;
  /** Tapping a link while following opens your own copy of it (#597). */
  readonly onCopy?: (url: string) => void;
}) {
  const webViewRef = useRef<WebView<object>>(null);
  const readyRef = useRef(false);
  const deliveredRef = useRef(AGENT_BROWSER_MIRROR_NOTHING_DELIVERED);
  const latestRef = useRef(props);
  const sentInteractiveRef = useRef<boolean | null>(null);
  const sentCopyLinksRef = useRef<boolean | null>(null);
  const [generation, setGeneration] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const inject = (messages: ReadonlyArray<AgentBrowserMirrorHostMessage>) => {
    const script = agentBrowserMirrorScript(messages);
    if (script !== null) webViewRef.current?.injectJavaScript(script);
  };
  const deliver = () => {
    if (!readyRef.current) return;
    const plan = planAgentBrowserMirrorDelivery(latestRef.current.content, deliveredRef.current);
    deliveredRef.current = plan.delivered;
    inject(plan.messages);
  };
  const restart = () => {
    readyRef.current = false;
    setLoadError(null);
    setGeneration((value) => value + 1);
  };

  // Every render: new batches go out once each, and the handlers see the latest props.
  useEffect(() => {
    latestRef.current = props;
    if (readyRef.current && sentInteractiveRef.current !== props.interactive) {
      sentInteractiveRef.current = props.interactive;
      inject([{ type: "interactive", on: props.interactive }]);
    }
    const copyLinks = props.onCopy !== undefined;
    if (readyRef.current && sentCopyLinksRef.current !== copyLinks) {
      sentCopyLinksRef.current = copyLinks;
      inject([{ type: "copyLinks", on: copyLinks }]);
    }
    deliver();
  });

  if (loadError !== null) {
    return (
      <View className="flex-1 items-center justify-center gap-4 px-6">
        <AppText selectable className="text-center text-sm text-foreground-muted">
          {loadError}
        </AppText>
        <Button label="Retry" onPress={restart} />
      </View>
    );
  }

  const fail = () => {
    readyRef.current = false;
    setLoadError("The agent's browser couldn't load. Check your connection and try again.");
  };

  return (
    <WebView<object>
      key={generation}
      ref={webViewRef}
      source={{ uri: props.pageUrl }}
      originWhitelist={["https://*", "http://*"]}
      accessibilityLabel="Agent's browser"
      style={{ flex: 1, backgroundColor: props.background ?? "transparent" }}
      scrollEnabled={false}
      bounces={false}
      overScrollMode="never"
      contentInsetAdjustmentBehavior="never"
      setSupportMultipleWindows={false}
      // The page focuses its own key catcher when the person taps a field while driving.
      keyboardDisplayRequiresUserAction={false}
      hideKeyboardAccessoryView
      allowsLinkPreview={false}
      textInteractionEnabled={false}
      // The mirror never leaves its page; the replayed page lives in frames inside it.
      onShouldStartLoadWithRequest={(request) =>
        request.isTopFrame === false || isAgentBrowserMirrorPage(request.url, props.pageUrl)
      }
      onLoadStart={() => {
        readyRef.current = false;
      }}
      onError={fail}
      onHttpError={fail}
      onContentProcessDidTerminate={restart}
      onRenderProcessGone={restart}
      onMessage={(event) => {
        if (!isAgentBrowserMirrorPage(event.nativeEvent.url, props.pageUrl)) return;
        const message = parseAgentBrowserMirrorPageMessage(event.nativeEvent.data);
        if (message === null) return;
        switch (message.type) {
          case "ready":
            readyRef.current = true;
            deliveredRef.current = AGENT_BROWSER_MIRROR_NOTHING_DELIVERED;
            sentInteractiveRef.current = latestRef.current.interactive;
            sentCopyLinksRef.current = latestRef.current.onCopy !== undefined;
            inject([
              { type: "interactive", on: latestRef.current.interactive },
              { type: "copyLinks", on: latestRef.current.onCopy !== undefined },
            ]);
            deliver();
            return;
          case "input":
            if (latestRef.current.interactive) latestRef.current.onInput(message.input);
            return;
          case "activity":
            latestRef.current.onActivity();
            return;
          case "copy":
            latestRef.current.onCopy?.(message.url);
            return;
          case "viewport":
            return;
        }
      }}
    />
  );
}
