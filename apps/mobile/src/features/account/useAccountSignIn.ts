import {
  buildAccountAuthorizeUrl,
  isAccountHandoffError,
  parseAccountReturn,
  redeemAccountHandoff,
} from "@t3tools/client-runtime/account";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AccountProvider,
  AccountSessionState,
  AccountSignInError,
} from "@t3tools/contracts/account";
import { SIGNALBOX_APP_URL } from "@t3tools/shared/signalboxAppUrl";
import { AsyncResult } from "effect/reactivity";
import Constants from "expo-constants";
import * as ExpoCrypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { connectPairingUrl } from "../../connection/onboarding";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildPairingUrl } from "../connection/pairing";
import { checkServerAccounts } from "./accountApi";
import {
  accountReturnUrl,
  createPkcePair,
  signInFailureCopy,
  type PkceCrypto,
} from "./signInLogic";

/** Mobile signs in to Signalbox Cloud only; dev builds pair with their server by deep link. */
const SERVER_URL = SIGNALBOX_APP_URL;

const expoPkceCrypto: PkceCrypto = {
  randomBytes: ExpoCrypto.getRandomBytes,
  sha256: async (data) => {
    const input = new Uint8Array(data.length);
    input.set(data);
    return new Uint8Array(await ExpoCrypto.digest(ExpoCrypto.CryptoDigestAlgorithm.SHA256, input));
  },
};

export type AccountServerState =
  | { readonly _tag: "checking" }
  | { readonly _tag: "unreachable" }
  /** The server answers but doesn't sign in with accounts. Nothing to do here but retry. */
  | { readonly _tag: "unavailable" }
  | { readonly _tag: "ready"; readonly session: AccountSessionState };

function describeError(error: unknown): string {
  // RN reports DNS, TLS and refused connections as a bare TypeError.
  if (error instanceof TypeError || (error instanceof Error && error.name === "AbortError")) {
    return "Couldn't reach Signalbox. Check your connection and try again.";
  }
  return error instanceof Error && error.message
    ? error.message
    : "Sign-in didn't go through. Try again.";
}

function notifyError() {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
}

/**
 * Drives native account sign-in to Signalbox: check that it signs in with
 * accounts, run the provider in the system browser with PKCE, redeem the
 * handoff, and register the environment through the normal pairing path.
 */
export function useAccountSignIn(options: { readonly onSignedIn?: () => void }) {
  const connectPairing = useAtomCommand(connectPairingUrl, { reportFailure: false });
  const [server, setServer] = useState<AccountServerState>({ _tag: "checking" });
  const [pendingProvider, setPendingProvider] = useState<AccountProvider | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const checkIdRef = useRef(0);
  const pendingRef = useRef(false);
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });

  // Settles a check that the caller already put into "checking".
  const settleCheck = useCallback(() => {
    const id = ++checkIdRef.current;
    checkServerAccounts(SERVER_URL).then(
      (result) => {
        if (id !== checkIdRef.current) return;
        setServer(
          result._tag === "pairing"
            ? { _tag: "unavailable" }
            : { _tag: "ready", session: result.session },
        );
      },
      () => {
        if (id === checkIdRef.current) setServer({ _tag: "unreachable" });
      },
    );
  }, []);

  // The server starts out "checking" (see the initial state).
  useEffect(() => {
    settleCheck();
  }, [settleCheck]);

  const retry = useCallback(() => {
    setServer({ _tag: "checking" });
    setFailure(null);
    settleCheck();
  }, [settleCheck]);

  const signIn = useCallback(
    async (provider: AccountProvider, loginHint?: string) => {
      if (server._tag !== "ready" || pendingRef.current) return;
      const serverUrl = SERVER_URL;
      const returnUrl = accountReturnUrl(Constants.expoConfig?.scheme);
      if (returnUrl === null) {
        setFailure("This build can't receive sign-in results.");
        return;
      }
      pendingRef.current = true;
      setPendingProvider(provider);
      setFailure(null);
      const report = (error: AccountSignInError) => {
        const copy = signInFailureCopy(error);
        if (copy === null) return;
        setFailure(copy);
        notifyError();
      };
      try {
        const { verifier, challenge } = await createPkcePair(expoPkceCrypto);
        const authorizeUrl = buildAccountAuthorizeUrl({
          provider,
          mode: "native",
          origin: serverUrl,
          returnUrl,
          challenge,
          ...(loginHint ? { loginHint } : {}),
        });
        const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, returnUrl);
        // Closing the browser sheet is a cancel, not an error.
        if (result.type !== "success") return;

        const parsed = parseAccountReturn(result.url);
        if (parsed?._tag !== "handoff") {
          report(parsed?.error ?? "failed");
          return;
        }

        const { credential } = await redeemAccountHandoff(serverUrl, {
          handoff: parsed.handoff,
          verifier,
        });
        const connected = await connectPairing({
          pairingUrl: buildPairingUrl(serverUrl, credential),
        });
        if (AsyncResult.isFailure(connected)) throw squashAtomCommandFailure(connected);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
          () => undefined,
        );
        optionsRef.current.onSignedIn?.();
      } catch (error) {
        if (isAccountHandoffError(error)) {
          report(error.code);
        } else {
          setFailure(describeError(error));
          notifyError();
        }
      } finally {
        pendingRef.current = false;
        setPendingProvider(null);
      }
    },
    [connectPairing, server],
  );

  return {
    server,
    pendingProvider,
    failure,
    retry,
    signIn,
  };
}
