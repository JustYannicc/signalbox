import {
  initialSignInRunner,
  SIGN_IN_EVALUATE_TIMEOUT_MS,
  SIGN_IN_LOOK_INTERVAL_MS,
  type SignInRunner,
  signInStep,
} from "@t3tools/client-runtime/browsing/sign-in";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { type RefObject, useEffect, useEffectEvent, useRef } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { signalboxSignIn, useSignInGrantsEnvironmentId } from "~/state/signalboxSignIn";

interface EngineWebview extends HTMLElement {
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
  getURL: () => string;
}

/** A script's value, or null once the page took too long or failed. */
const answerWithin = (answer: Promise<unknown>) =>
  new Promise<unknown>((resolve) => {
    const timer = window.setTimeout(() => resolve(null), SIGN_IN_EVALUATE_TIMEOUT_MS);
    const settle = (value: unknown) => {
      window.clearTimeout(timer);
      resolve(value);
    };
    answer.then(settle, () => settle(null));
  });

/**
 * Signs this desktop's tab in from the person's 1Password (#586) while the
 * tab is in front of them: the panel shows it and the window has focus. A tab
 * that only synced here never signs in. Only on the environment that keeps
 * sign-in grants, which is where the person's 1Password is linked.
 */
export function useTabSignIn(input: {
  readonly threadRef: ScopedThreadRef;
  readonly webviewRef: RefObject<HTMLElement | null>;
  readonly webviewGeneration: number;
  readonly visible: boolean;
}) {
  const { threadRef, webviewRef, webviewGeneration, visible } = input;
  const grantsEnvironmentId = useSignInGrantsEnvironmentId();
  const allowed = useAtomValue(signalboxSignIn.fill.permissionAtom(threadRef.environmentId));
  const enabled = visible && allowed && grantsEnvironmentId === threadRef.environmentId;
  const runner = useRef<SignInRunner>(initialSignInRunner);
  const busy = useRef(false);

  const look = useEffectEvent(async () => {
    const element = webviewRef.current as EngineWebview | null;
    if (!element || busy.current) return;
    const focused = document.hasFocus() || document.activeElement === element;
    if (document.visibilityState !== "visible" || !focused) return;
    busy.current = true;
    try {
      runner.current = await signInStep({
        runner: runner.current,
        now: Date.now,
        engine: {
          evaluate: (script) => answerWithin(element.executeJavaScript(script)),
          url: () => {
            try {
              return element.getURL();
            } catch {
              return null;
            }
          },
        },
        ask: signalboxSignIn.askFill(appAtomRegistry, threadRef),
      });
    } finally {
      busy.current = false;
    }
  });

  useEffect(() => {
    if (!enabled) return;
    const element = webviewRef.current;
    const loaded = () => void look();
    element?.addEventListener("did-finish-load", loaded);
    window.addEventListener("focus", loaded);
    const timer = window.setInterval(() => void look(), SIGN_IN_LOOK_INTERVAL_MS);
    void look();
    return () => {
      element?.removeEventListener("did-finish-load", loaded);
      window.removeEventListener("focus", loaded);
      window.clearInterval(timer);
    };
  }, [enabled, webviewGeneration, webviewRef]);
}
