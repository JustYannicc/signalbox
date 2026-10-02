import { parseAccountReturn } from "@t3tools/client-runtime/account";
import type { AccountProvider, AccountSignInError } from "@t3tools/contracts/account";
import { useEffect, useRef, useState } from "react";

import { APP_BASE_NAME } from "../branding";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import {
  AccountFlowError,
  cancelNativeSignIn,
  completeNativeSignIn,
  isDesktop,
  readAccountSession,
  startAccountSignIn,
  startNativeSignIn,
} from "./accountSession";
import { appForwardUrl, type AppForward } from "./appForward";
import { SignInFrame, SignInNotice } from "./SignInFrame";
import { parseVerifyRequest } from "./verifyEmail";
import { VerifyEmailScreen } from "./VerifyEmailScreen";
import { DesktopSignInOptions, WebSignInOptions, type DesktopScreenHint } from "./SignInOptions";

export interface SignInSearch {
  readonly returnTo?: string;
  readonly error?: string;
  readonly handoff?: string;
  readonly selectAccount?: "1";
}

/**
 * The sign-in screen, in three roles:
 * - web: provider buttons and email, all one "Continue with …" flow;
 * - desktop: sign up or sign in, finished in the system browser;
 * - the system browser's landing page for desktop sign-in, which forwards the
 *   result to the app (`?returnUrl=` plus `?handoff=` or `?error=`).
 * `searchStr` carries those returns; `onConsumed` strips them so a reload
 * doesn't replay them.
 */
export function SignInScreen({
  search,
  searchStr,
  onConsumed,
}: {
  readonly search: SignInSearch;
  readonly searchStr: string;
  readonly onConsumed: () => void;
}) {
  const session = readAccountSession();
  const desktop = isDesktop();
  // Web-only arrivals: an emailed-code step, or desktop sign-in finishing here.
  const [verifyRequest] = useState(() => (desktop ? null : parseVerifyRequest(searchStr)));
  const [forward] = useState(() => (desktop ? null : appForwardUrl(searchStr)));
  const [notice, setNotice] = useState<AccountSignInError | null>(null);
  const [email, setEmail] = useState("");
  const selectAccount = search.selectAccount === "1";
  const [pending, setPending] = useState<AccountProvider | null>(null);
  const [desktopPending, setDesktopPending] = useState<DesktopScreenHint | null>(null);
  const [waitingOn, setWaitingOn] = useState<DesktopScreenHint | null>(null);
  const [completing, setCompleting] = useState(false);
  const redeemedHandoff = useRef<string | null>(null);

  // A return can land on first load or, on desktop, as a hash change while this
  // screen is already waiting. Adopt each new one during render so the first
  // paint shows it; the effect below does the I/O.
  const [adoptedSearch, setAdoptedSearch] = useState<string | null>(null);
  const accountReturn = forward || verifyRequest ? null : parseReturn(searchStr);
  if (adoptedSearch !== searchStr) {
    setAdoptedSearch(searchStr);
    if (accountReturn) {
      setPending(null);
      setWaitingOn(null);
      setCompleting(accountReturn._tag === "handoff" && desktop);
      if (accountReturn._tag === "error") {
        setNotice(accountReturn.error);
      } else if (!desktop) {
        // A web handoff without a valid app link has nowhere to go.
        setNotice("failed");
      }
    }
  }

  const handoff = desktop && accountReturn?._tag === "handoff" ? accountReturn.handoff : null;
  const hasReturn = accountReturn !== null;
  useEffect(() => {
    if (!hasReturn) return;
    onConsumed();
    if (!handoff || redeemedHandoff.current === handoff) return;
    redeemedHandoff.current = handoff;
    completeNativeSignIn(handoff).catch((error: unknown) => {
      setCompleting(false);
      setNotice(error instanceof AccountFlowError ? error.code : "failed");
    });
  }, [handoff, hasReturn, onConsumed]);

  // Back from the provider via bfcache: the page is restored mid-"pending".
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setPending(null);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  const startWeb = (provider: AccountProvider) => {
    setPending(provider);
    setNotice(null);
    try {
      startAccountSignIn({
        provider,
        ...(provider === "email" && email.trim() ? { loginHint: email.trim() } : {}),
        ...(selectAccount ? { selectAccount: true } : {}),
        ...(search.returnTo ? { returnTo: search.returnTo } : {}),
      });
    } catch (error) {
      setPending(null);
      setNotice(error instanceof AccountFlowError ? error.code : "failed");
    }
  };

  const startDesktop = async (screenHint: DesktopScreenHint) => {
    setDesktopPending(screenHint);
    setNotice(null);
    try {
      await startNativeSignIn({
        screenHint,
        ...(selectAccount ? { selectAccount: true } : {}),
        ...(search.returnTo ? { returnTo: search.returnTo } : {}),
      });
      setWaitingOn(screenHint);
    } catch (error) {
      setNotice(error instanceof AccountFlowError ? error.code : "failed");
    } finally {
      setDesktopPending(null);
    }
  };

  if (verifyRequest) return <VerifyEmailScreen request={verifyRequest} />;
  if (forward) return <AppForwardScreen forward={forward} />;

  if (completing) {
    return (
      <SignInFrame title="Signing you in">
        <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Spinner size="sm" tone="muted" aria-hidden />
          One moment.
        </p>
      </SignInFrame>
    );
  }

  if (waitingOn) {
    return (
      <SignInFrame
        title="Finish in your browser"
        description={`${APP_BASE_NAME} comes back when you're done.`}
      >
        <div className="mt-6 grid gap-2 sm:grid-cols-2">
          <Button
            size="lg"
            variant="outline"
            disabled={desktopPending !== null}
            onClick={() => void startDesktop(waitingOn)}
          >
            Open browser again
          </Button>
          <Button
            size="lg"
            variant="ghost"
            onClick={() => {
              cancelNativeSignIn();
              setWaitingOn(null);
            }}
          >
            Cancel
          </Button>
        </div>
      </SignInFrame>
    );
  }

  return (
    <SignInFrame title={`Sign in to ${APP_BASE_NAME}`}>
      {notice ? <SignInNotice error={notice} /> : null}
      {desktop ? (
        <DesktopSignInOptions
          pending={desktopPending}
          onStart={(screenHint) => void startDesktop(screenHint)}
        />
      ) : (
        <WebSignInOptions
          providers={session?.providers ?? []}
          pending={pending}
          email={email}
          onEmailChange={setEmail}
          onStart={startWeb}
        />
      )}
    </SignInFrame>
  );
}

const FORWARD_ERROR_TITLES: Record<AccountSignInError, string> = {
  cancelled: "Sign-in cancelled",
  expired: "That sign-in expired",
  failed: "Sign-in didn't work",
};

/** System browser, desktop sign-in done: hand the result to the app right away. */
function AppForwardScreen({ forward }: { readonly forward: AppForward }) {
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    window.location.assign(forward.url);
  }, [forward.url]);

  return (
    <SignInFrame
      title={forward._tag === "handoff" ? "You're signed in" : FORWARD_ERROR_TITLES[forward.error]}
      description={
        forward._tag === "handoff"
          ? `Opening ${APP_BASE_NAME}. You can close this tab.`
          : `Head back to ${APP_BASE_NAME} to try again. You can close this tab.`
      }
    >
      <div className="mt-6 grid">
        <Button size="lg" onClick={() => window.location.assign(forward.url)}>
          Open {APP_BASE_NAME}
        </Button>
      </div>
    </SignInFrame>
  );
}

function parseReturn(searchStr: string) {
  return parseAccountReturn(new URL(searchStr || "?", "http://signalbox.invalid"));
}
