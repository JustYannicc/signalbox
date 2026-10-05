import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { CopyIcon } from "lucide-react";
import { useRef, useState } from "react";

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
 * Signs one more account into a hub instance. Every sign-in adds an account,
 * so there is no signed-in state here, only "add another".
 *
 * When the environment runs on this machine the redirect lands on it
 * directly. From another device the provider redirects to a localhost page
 * that cannot load, and the user pastes that address back here.
 */
export function HubSignIn({
  environmentId,
  instanceId,
  account,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  /** "ChatGPT" or "Claude". */
  readonly account: string;
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

  const active =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const interaction = auth?.interaction?.type === "browser" ? auth.interaction : null;
  const flowId = auth?.flowId ?? null;
  const callbackUrl = pasted.flowId === flowId ? pasted.value : "";

  async function run(command: () => Promise<AtomCommandResult<unknown, unknown>>) {
    if (pendingRef.current) return;
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
  }

  const description = active
    ? auth?.phase === "verifying"
      ? "Checking the account…"
      : local
        ? `Finish signing in to ${account} in your browser.`
        : `Sign in to ${account} in your browser. It then opens a page that cannot load: copy that page's address and paste it below.`
    : auth?.phase === "failed"
      ? (auth.message ?? "Sign-in failed. Try again.")
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
                onClick={() =>
                  void run(() => cancel({ environmentId, input: { instanceId, flowId } }))
                }
              >
                Cancel
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={disabled || pending || !auth}
                onClick={() =>
                  void run(() =>
                    start({
                      environmentId,
                      input: { instanceId, callbackMode: local ? "server" : "client" },
                    }),
                  )
                }
              >
                {auth?.phase === "failed" ? "Try again" : `Sign in with ${account}`}
              </Button>
            )}
          </div>
        }
      />
      {active && interaction?.acceptsCallback && !local && flowId ? (
        <form
          className="flex flex-wrap items-center gap-2 px-3 py-3 sm:px-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!callbackUrl.trim()) return;
            void run(() =>
              complete({
                environmentId,
                input: { instanceId, flowId, callbackUrl: callbackUrl.trim() },
              }),
            );
          }}
        >
          <Input
            aria-label="Address of the page that did not load"
            placeholder="Paste the full address"
            className="min-w-0 flex-1"
            value={callbackUrl}
            onChange={(event) => setPasted({ flowId, value: event.target.value })}
          />
          <Button type="submit" size="sm" disabled={pending || !callbackUrl.trim()}>
            Finish sign-in
          </Button>
        </form>
      ) : null}
    </div>
  );
}
