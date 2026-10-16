import {
  initialSignInRunner,
  SIGN_IN_EVALUATE_TIMEOUT_MS,
  SIGN_IN_LOOK_INTERVAL_MS,
  type SignInRunner,
  signInStep,
} from "@t3tools/client-runtime/browsing/sign-in";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { type RefObject, useEffect, useEffectEvent, useRef } from "react";
import type { WebView, WebViewMessageEvent } from "react-native-webview";

import { appAtomRegistry } from "../../state/atom-registry";
import { signalboxSignIn, useSignInGrantsEnvironmentId } from "../../state/signalboxSignIn";

const MESSAGE_TYPE = "signalbox-sign-in";

/**
 * Signs this phone's tab in from the person's 1Password (#586) while the tab
 * is in front of them: the panel shows it and the app is in the foreground.
 * A tab that only synced here never signs in. The WebView runs scripts
 * without answering, so each one posts its value back as a message, which
 * `onMessage` takes before the page's own messages.
 */
export function useTabSignIn(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly webView: RefObject<WebView<object> | null>;
  /** Where the WebView says it is. */
  readonly url: string | null;
  readonly live: boolean;
  readonly pageReady: boolean;
}) {
  const { environmentId, threadId, webView, live, pageReady } = input;
  const grantsEnvironmentId = useSignInGrantsEnvironmentId();
  const allowed = useAtomValue(signalboxSignIn.fill.permissionAtom(environmentId));
  const enabled = live && pageReady && allowed && grantsEnvironmentId === environmentId;
  const runner = useRef<SignInRunner>(initialSignInRunner);
  const busy = useRef(false);
  const url = useRef(input.url);
  useEffect(() => {
    url.current = input.url;
  }, [input.url]);
  const answers = useRef(new Map<number, (value: unknown) => void>());
  const nextId = useRef(0);

  const evaluate = (script: string) =>
    new Promise<unknown>((resolve) => {
      const view = webView.current;
      if (!view) return resolve(null);
      const id = ++nextId.current;
      const timer = setTimeout(() => {
        answers.current.delete(id);
        resolve(null);
      }, SIGN_IN_EVALUATE_TIMEOUT_MS);
      answers.current.set(id, (value) => {
        clearTimeout(timer);
        answers.current.delete(id);
        resolve(value);
      });
      view.injectJavaScript(`(function () {
  var value = null;
  try { value = ${script}; } catch (error) {}
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: ${JSON.stringify(MESSAGE_TYPE)}, id: ${id}, value: value }));
})();
true;`);
    });

  const look = useEffectEvent(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      runner.current = await signInStep({
        runner: runner.current,
        now: Date.now,
        engine: { evaluate, url: () => url.current },
        ask: signalboxSignIn.askFill(appAtomRegistry, { environmentId, threadId }),
      });
    } finally {
      busy.current = false;
    }
  });

  // Scripts still waiting when the tab goes answer nothing.
  useEffect(() => {
    const waiting = answers.current;
    return () => {
      for (const answer of waiting.values()) answer(null);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void look();
    const timer = setInterval(() => void look(), SIGN_IN_LOOK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled]);

  /** Takes a script's answer; false for every other message. */
  const onMessage = (event: WebViewMessageEvent) => {
    const data = event.nativeEvent.data;
    // Most messages are the page's own reports: tell them apart before parsing anything.
    if (data.length > 8_192 || !data.includes(MESSAGE_TYPE)) return false;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return false;
    }
    if (typeof message !== "object" || message === null) return false;
    const { type, id, value } = message as Record<string, unknown>;
    if (type !== MESSAGE_TYPE) return false;
    if (typeof id === "number") answers.current.get(id)?.(value);
    return true;
  };

  return { onMessage };
}
