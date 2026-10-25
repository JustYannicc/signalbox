import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { isSignInHandBack } from "@t3tools/client-runtime/state/signalboxPoolSignIn";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { CopyIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsRow } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/**
 * A tab opened during the click, so the browser lets it through; the sign-in
 * page loads into it once the hub has its address.
 */
function openPendingTab(account: string) {
  const tab = window.open("", "_blank");
  if (!tab) return null;
  tab.opener = null;
  tab.document.title = `${account} sign-in`;
  tab.document.body.textContent = `Opening the ${account} sign-in page…`;
  return tab;
}

/**
 * Signs one more account into a hub instance. Every sign-in adds an account,
 * so there is no signed-in state here, only "add another".
 *
 * When the environment runs on this machine the redirect lands on it
 * directly, and in the desktop app the app catches it. Otherwise the user
 * pastes back what the sign-in ends on: the code a provider's page shows
 * (`acceptsCode` without `acceptsCallback`), or the address of the localhost
 * page that cannot load. A device code needs nothing handed back.
 */
export function HubSignIn({
  environmentId,
  instanceId,
  account,
  methodId,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  /** "ChatGPT" or "Claude". */
  readonly account: string;
  /** A specific sign-in method, such as signing one dead account in again. */
  readonly methodId?: string;
  readonly disabled?: boolean;
}) {
  const target = { environmentId, input: { instanceId } };
  const auth = useEnvironmentQuery(serverEnvironment.providerAuthState(target)).data;
  const commands = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startProviderAuth, commands);
  const complete = useAtomCommand(serverEnvironment.completeProviderAuth, commands);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, commands);
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const local = httpBaseUrl !== null && isLoopbackHost(new URL(httpBaseUrl).hostname);
  const [pasted, setPasted] = useState({ flowId: "", value: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  const verifying = auth?.phase === "verifying";
  const active = auth?.phase === "starting" || auth?.phase === "waiting" || verifying;
  const interaction =
    auth?.interaction?.type === "browser" || auth?.interaction?.type === "deviceCode"
      ? auth.interaction
      : null;
  const userCode = interaction?.type === "deviceCode" ? interaction.userCode : null;
  const acceptsCallback = interaction?.type === "browser" && interaction.acceptsCallback === true;
  // The provider's own page shows a code to paste: there is no localhost page to copy from.
  const showsCode =
    interaction?.type === "browser" && interaction.acceptsCode === true && !acceptsCallback;
  const flowId = auth?.flowId ?? null;
  const callbackUrl = pasted.flowId === flowId ? pasted.value : "";
  // In the desktop app the app itself catches the provider's localhost redirect: one click.
  const desktopReceive = window.desktopBridge?.receiveProviderAuthCallback;
  const receiving = useRef<string | null>(null);
  // Only a sign-in started here opens the browser; one from another device or tab does not.
  const startedHere = useRef(false);
  const pendingTab = useRef<Window | null>(null);
  const openedUrl = useRef<string | null>(null);

  /** Whether the command went through. */
  async function run(command: () => Promise<AtomCommandResult<unknown, unknown>>) {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const result = await command().catch(() => null);
    if (result === null) setError("Sign-in failed. Try again.");
    else if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Sign-in failed. Try again.");
    }
    pendingRef.current = false;
    setPending(false);
    return result?._tag === "Success";
  }

  const closePendingTab = () => {
    pendingTab.current?.close();
    pendingTab.current = null;
  };

  const finishOnThisComputer = useEffectEvent((url: string, flow: string) => {
    if (!desktopReceive || !startedHere.current || receiving.current === url) return;
    receiving.current = url;
    void desktopReceive(url)
      .then((received) =>
        run(() =>
          complete({ environmentId, input: { instanceId, flowId: flow, callbackUrl: received } }),
        ),
      )
      .catch(() => {
        // Cancelled or replaced on purpose: nothing went wrong.
        if (receiving.current !== url) return;
        receiving.current = null;
        setError("Could not finish sign-in on this computer. Paste the page's address below.");
      });
  });
  const openSignInPage = useEffectEvent((url: string) => {
    if (!startedHere.current || openedUrl.current === url) return;
    // The desktop catch opens the page itself once it listens.
    if (desktopReceive && acceptsCallback) return;
    openedUrl.current = url;
    const tab = pendingTab.current;
    pendingTab.current = null;
    if (tab && !tab.closed) {
      tab.location.href = url;
      return;
    }
    void ensureLocalApi()
      .shell.openExternal(url)
      .catch(() => setError("Could not open the browser. Use Open sign-in page."));
  });
  const signInUrl = active ? (interaction?.url ?? null) : null;
  useEffect(() => {
    if (signInUrl) openSignInPage(signInUrl);
  }, [signInUrl]);
  // A sign-in that ends, or never gets going, leaves no blank tab behind; a later one
  // from another device opens nothing here.
  const endedFlow = active ? null : `${auth?.phase}:${flowId}`;
  useEffect(() => {
    if (endedFlow === null) return;
    startedHere.current = false;
    pendingTab.current?.close();
    pendingTab.current = null;
  }, [endedFlow]);
  // Leaving takes the paste box and the desktop catch with it, so a sign-in started
  // here ends too, instead of holding the pool's container awake for nothing.
  const abandon = useEffectEvent(() => {
    pendingTab.current?.close();
    if (!startedHere.current || !active || !flowId) return;
    void cancel({ environmentId, input: { instanceId, flowId } });
  });
  useEffect(() => abandon, []);

  const finish = (address: string) => {
    if (!flowId || !address) return;
    void run(() =>
      complete({ environmentId, input: { instanceId, flowId, callbackUrl: address } }),
    );
  };

  const interactionUrl = active && acceptsCallback ? (interaction?.url ?? null) : null;
  useEffect(() => {
    if (!interactionUrl || !flowId) return;
    finishOnThisComputer(interactionUrl, flowId);
    // Leaving the dialog, or the sign-in ending, frees the port for the next try.
    return () => {
      if (receiving.current !== interactionUrl) return;
      receiving.current = null;
      void window.desktopBridge?.cancelProviderAuthCallback?.(interactionUrl);
    };
  }, [interactionUrl, flowId]);

  const description = active
    ? auth?.phase === "verifying"
      ? "Checking the account…"
      : userCode
        ? `Enter this code on the ${account} page that opened. Signalbox finishes on its own.`
        : showsCode
          ? `Sign in to ${account} in the new tab. It ends on a page with a code: copy it and paste it below.`
          : desktopReceive || !acceptsCallback
            ? `Finish signing in to ${account} in your browser.`
            : `Sign in to ${account} in the new tab. When it ends on a page that won't load, copy that page's address and paste it below.`
    : auth?.phase === "failed"
      ? (auth.message ?? "Sign-in failed. Try again.")
      : methodId
        ? `Sign in with the same ${account} account.`
        : `Sign in with the ${account} account you want to add.`;

  return (
    <div className="divide-y divide-border/50">
      <SettingsRow
        title={`${account} account`}
        description={<span role="status">{error ?? description}</span>}
        control={
          <div className="flex flex-wrap items-center gap-1.5">
            {active && interaction ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void ensureLocalApi()
                      .shell.openExternal(interaction.url)
                      .catch(() => setError("Could not open the browser. Copy the link instead."))
                  }
                >
                  Open sign-in page
                </Button>
                <Button
                  aria-label="Copy sign-in link"
                  size="icon-sm"
                  variant="ghost-muted"
                  onClick={() => void writeTextToClipboard(interaction.url, "Sign-in link")}
                >
                  <CopyIcon />
                </Button>
              </>
            ) : null}
            {active && flowId ? (
              <Button
                size="sm"
                variant="ghost-muted"
                disabled={pending}
                onClick={() => {
                  if (interaction && receiving.current === interaction.url) {
                    receiving.current = null;
                    void window.desktopBridge?.cancelProviderAuthCallback?.(interaction.url);
                  }
                  void run(() => cancel({ environmentId, input: { instanceId, flowId } }));
                }}
              >
                Cancel
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={disabled || pending || !auth}
                onClick={() => {
                  startedHere.current = true;
                  openedUrl.current = null;
                  if (!window.desktopBridge) pendingTab.current = openPendingTab(account);
                  void run(() =>
                    start({
                      environmentId,
                      input: {
                        instanceId,
                        // A local hub takes the redirect itself; the desktop app catches it, so
                        // the hub must not hold that port. Left out, the redirect can't reach
                        // anything here, and Signalbox Cloud signs Claude in with a code to paste.
                        ...(desktopReceive
                          ? { callbackMode: "client" as const }
                          : local
                            ? { callbackMode: "server" as const }
                            : {}),
                        ...(methodId ? { methodId } : {}),
                      },
                    }),
                  ).then((started) => {
                    if (!started) closePendingTab();
                  });
                }}
              >
                {auth?.phase === "failed"
                  ? "Try again"
                  : methodId
                    ? "Sign in again"
                    : `Sign in with ${account}`}
              </Button>
            )}
          </div>
        }
      />
      {active && userCode ? (
        <div className="flex items-center gap-2 px-3 py-3 sm:px-4">
          <code className="select-all rounded-md bg-muted px-3 py-1.5 font-mono text-lg tracking-widest text-foreground">
            {userCode}
          </code>
          <Button
            aria-label="Copy code"
            size="icon-sm"
            variant="ghost-muted"
            onClick={() => void writeTextToClipboard(userCode, "Sign-in code")}
          >
            <CopyIcon />
          </Button>
        </div>
      ) : null}
      {/* Offered locally too: the redirect only reaches the hub when the browser runs beside it. */}
      {/* Gone while the account is checked: there is nothing left to hand back. */}
      {active && (acceptsCallback || showsCode) && flowId && !verifying ? (
        <form
          className="flex flex-wrap items-center gap-2 px-3 py-3 sm:px-4"
          onSubmit={(event) => {
            event.preventDefault();
            finish(callbackUrl.trim());
          }}
        >
          <Input
            aria-label={
              showsCode ? "Code from the sign-in page" : "Address of the page that did not load"
            }
            placeholder={
              showsCode
                ? "Paste the code"
                : local
                  ? "Page didn't finish? Paste its full address"
                  : "Paste the full address"
            }
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1"
            value={callbackUrl}
            onChange={(event) => setPasted({ flowId, value: event.target.value })}
            onPaste={(event) => {
              const text = event.clipboardData.getData("text").trim();
              if (!isSignInHandBack(text)) return;
              event.preventDefault();
              setPasted({ flowId, value: text });
              finish(text);
            }}
          />
          <Button type="submit" size="sm" disabled={pending || !callbackUrl.trim()}>
            Finish sign-in
          </Button>
        </form>
      ) : null}
    </div>
  );
}
