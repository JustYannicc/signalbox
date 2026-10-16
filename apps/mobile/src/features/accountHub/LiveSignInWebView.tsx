// signalbox: a provider sign-in in a cloud browser, shown through its live view (#205).
import { useEffect, useState } from "react";
import { View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";

/** How long the live view gets to show its first frame before it's reloaded once. */
const WATCHDOG_MS = 15_000;

/**
 * Kernel's live view tells the page embedding it when frames render. Loaded
 * on its own here, it posts to itself, so this passes its events on.
 */
const FORWARD_EVENTS = `(function () {
  var forwarded = ["KERNEL_PLAYING", "KERNEL_CONNECTION_FAILED", "KERNEL_CONNECTION_TIMEOUT"];
  window.addEventListener("message", function (event) {
    var type = event.data && event.data.type;
    if (forwarded.indexOf(type) >= 0 && window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(type);
    }
  });
})();
true;`;

type FrameState = "connecting" | "playing" | "failed";

export function LiveSignInWebView(props: {
  readonly url: string;
  readonly site: string;
  readonly account: string;
}) {
  const [{ attempt, state }, setFrame] = useState<{ attempt: number; state: FrameState }>({
    attempt: 0,
    state: "connecting",
  });

  useEffect(() => {
    // One silent reload for a stall, then it says so.
    const watchdog = setTimeout(() => {
      setFrame((frame) =>
        frame.attempt !== attempt || frame.state !== "connecting"
          ? frame
          : frame.attempt === 0
            ? { attempt: 1, state: "connecting" }
            : { ...frame, state: "failed" },
      );
    }, WATCHDOG_MS);
    return () => clearTimeout(watchdog);
  }, [attempt]);

  const settle = (state: FrameState) =>
    setFrame((frame) => (frame.state === state ? frame : { ...frame, state }));
  const onMessage = (event: WebViewMessageEvent) => {
    settle(event.nativeEvent.data === "KERNEL_PLAYING" ? "playing" : "failed");
  };

  return (
    <View className="flex-1">
      <WebView
        key={attempt}
        source={{ uri: props.url }}
        originWhitelist={["https://*"]}
        accessibilityLabel={`${props.account} sign-in`}
        style={{ flex: 1, backgroundColor: "transparent" }}
        injectedJavaScriptBeforeContentLoaded={FORWARD_EVENTS}
        onMessage={onMessage}
        onError={() => settle("failed")}
        // The live view is a video stream with its own input; it must play inline, unprompted.
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        setSupportMultipleWindows={false}
        keyboardDisplayRequiresUserAction={false}
      />
      {state === "playing" ? null : (
        <View className="absolute inset-0 items-center justify-center gap-3 bg-subtle px-6">
          {state === "connecting" ? (
            <>
              <AppActivityIndicator />
              <Text className="text-sm text-foreground-muted">Opening {props.site}…</Text>
            </>
          ) : (
            <>
              <Text className="text-center text-sm text-foreground-muted">
                The sign-in browser didn't load.
              </Text>
              <Button
                label="Reload"
                onPress={() => setFrame({ attempt: attempt + 1, state: "connecting" })}
              />
            </>
          )}
        </View>
      )}
    </View>
  );
}
