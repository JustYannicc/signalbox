import {
  AccountHandoffError,
  buildAccountAuthorizeUrl,
  parseAccountReturn,
  redeemAccountHandoff,
} from "@t3tools/client-runtime/account";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AccountProvider,
  AccountSessionState,
  AccountSignInError,
} from "@t3tools/contracts/account";
import { AsyncResult } from "effect/unstable/reactivity";
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
  normalizeServerUrl,
  serverDisplayHost,
  signInFailureCopy,
  type PkceCrypto,
} from "./signInLogic";

/** Build-time default server (`EXPO_PUBLIC_SIGNALBOX_SERVER_URL`); null asks for one. */
export const DEFAULT_SERVER_URL = normalizeServerUrl(process.env.EXPO_PUBLIC_SIGNALBOX_SERVER_URL);

const expoPkceCrypto: PkceCrypto = {
  randomBytes: ExpoCrypto.getRandomBytes,
  sha256: async (data) => {
    const input = new Uint8Array(data.length);
    input.set(data);
    return new Uint8Array(await ExpoCrypto.digest(ExpoCrypto.CryptoDigestAlgorithm.SHA256, input));
  },
};

export type AccountServerState =
  | { readonly _tag: "choose" }
  | { readonly _tag: "checking"; readonly serverUrl: string }
  | { readonly _tag: "unreachable"; readonly serverUrl: string }
  | { readonly _tag: "pairing"; readonly serverUrl: string }
  | {
      readonly _tag: "ready";
      readonly serverUrl: string;
      readonly session: AccountSessionState;
    };

function describeError(error: unknown, serverUrl: string): string {
  // RN reports DNS, TLS and refused connections as a bare TypeError.
  if (error instanceof TypeError || (error instanceof Error && error.name === "AbortError")) {
    return `Couldn't reach ${serverDisplayHost(serverUrl)}. Check your connection and try again.`;
  }
  return error instanceof Error && error.message
    ? error.message
    : "Sign-in didn't go through. Try again.";
}

function notifyError() {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
}

/**
 * Drives native account sign-in against one server: check that it signs in
 * with accounts, run the provider in the system browser with PKCE, redeem the
 * handoff, and register the environment through the normal pairing path.
 */
export function useAccountSignIn(options: {
  /** The server only pairs with codes. Called when the person picked that server themselves. */
  readonly onPairingRequired: (serverUrl: string) => void;
  readonly onSignedIn?: () => void;
}) {
  const connectPairing = useAtomCommand(connectPairingUrl, { reportFailure: false });
  const [server, setServer] = useState<AccountServerState>(() =>
    DEFAULT_SERVER_URL ? { _tag: "checking", serverUrl: DEFAULT_SERVER_URL } : { _tag: "choose" },
  );
  const [pendingProvider, setPendingProvider] = useState<AccountProvider | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const checkIdRef = useRef(0);
  const pendingRef = useRef(false);
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });

  // Settles a check that the caller already put into "checking".
  const settleCheck = useCallback((serverUrl: string, chosenByUser: boolean) => {
    const id = ++checkIdRef.current;
    checkServerAccounts(serverUrl).then(
      (result) => {
        if (id !== checkIdRef.current) return;
        if (result._tag === "pairing") {
          setServer({ _tag: "pairing", serverUrl });
          if (chosenByUser) optionsRef.current.onPairingRequired(serverUrl);
          return;
        }
        setServer({ _tag: "ready", serverUrl, session: result.session });
      },
      () => {
        if (id === checkIdRef.current) setServer({ _tag: "unreachable", serverUrl });
      },
    );
  }, []);

  const check = useCallback(
    (serverUrl: string, chosenByUser: boolean) => {
      setServer({ _tag: "checking", serverUrl });
      setFailure(null);
      settleCheck(serverUrl, chosenByUser);
    },
    [settleCheck],
  );

  // The default server starts out "checking" (see the initial state).
  useEffect(() => {
    if (DEFAULT_SERVER_URL) settleCheck(DEFAULT_SERVER_URL, false);
  }, [settleCheck]);

  /** Returns false when the input isn't a server address. */
  const submitServer = useCallback(
    (input: string) => {
      const serverUrl = normalizeServerUrl(input);
      if (serverUrl === null) return false;
      check(serverUrl, true);
      return true;
    },
    [check],
  );

  const changeServer = useCallback(() => {
    if (pendingRef.current) return;
    checkIdRef.current += 1;
    setFailure(null);
    setServer({ _tag: "choose" });
  }, []);

  const retry = useCallback(() => {
    if (server._tag !== "choose") check(server.serverUrl, false);
  }, [check, server]);

  const signIn = useCallback(
    async (provider: AccountProvider, loginHint?: string) => {
      if (server._tag !== "ready" || pendingRef.current) return;
      const serverUrl = server.serverUrl;
      const returnUrl = accountReturnUrl(Constants.expoConfig?.scheme);
      if (returnUrl === null) {
        setFailure("This build can't receive sign-in results. Pair with a code instead.");
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
        if (error instanceof AccountHandoffError) {
          report(error.code);
        } else {
          setFailure(describeError(error, serverUrl));
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
    submitServer,
    changeServer,
    retry,
    signIn,
  };
}
