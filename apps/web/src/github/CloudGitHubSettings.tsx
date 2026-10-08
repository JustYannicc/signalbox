import type { EnvironmentId, SourceControlProviderAuth } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { readLocalApi } from "../localApi";
import { useServerConfigs } from "../state/entities";
import { useEnvironmentHttpBaseUrl } from "../state/environments";

/** Whether `environmentId` is a Signalbox Cloud, which connects GitHub its own way. */
export function useIsSignalboxCloud(environmentId: EnvironmentId | null): boolean {
  const configs = useServerConfigs();
  return (
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.signalboxCloud === true
  );
}

/**
 * GitHub in Signalbox Cloud (#135): connecting runs Signalbox's GitHub App in
 * a browser signed in to the cloud, which then acts as the user on the
 * repositories they install the App on. The cloud keeps the tokens; this only
 * opens its pages. On the cloud's own web app that is this tab; anywhere
 * else, the system browser.
 */
export function CloudGitHubSettings({
  environmentId,
  auth,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly auth: SourceControlProviderAuth;
  readonly onChanged: () => void;
}) {
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const account = Option.getOrNull(auth.account);
  const [disconnecting, setDisconnecting] = useState(false);

  // Connecting finishes in another tab or the system browser; coming back is when to look again.
  useEffect(() => {
    window.addEventListener("focus", onChanged);
    return () => window.removeEventListener("focus", onChanged);
  }, [onChanged]);

  if (httpBaseUrl === null) return null;
  const pageUrl = (path: string) => new URL(path, httpBaseUrl);
  const sameOrigin = pageUrl("/").origin === window.location.origin;
  const open = (path: string) => {
    const url = pageUrl(path);
    if (sameOrigin && path === "/api/github/connect") window.location.assign(url);
    else void readLocalApi()?.shell.openExternal(url.toString());
  };

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      await fetch(pageUrl("/api/github/disconnect"), { method: "POST", credentials: "include" });
      onChanged();
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="grid gap-3">
      <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
        {account === null
          ? "Connect GitHub to import its repositories and open pull requests from threads. Signalbox acts as you, on the repositories you install its GitHub app on."
          : "Signalbox acts as this account on the repositories its GitHub app is installed on. Install it on more to import them."}
      </p>
      <div className="flex flex-wrap gap-2">
        {account === null ? (
          <Button size="sm" onClick={() => open("/api/github/connect")}>
            Connect GitHub
          </Button>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={() => open("/api/github/install")}>
              Choose repositories
            </Button>
            {/* Disconnecting needs this browser's cloud session; elsewhere it happens on the web. */}
            {sameOrigin ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={disconnecting}
                onClick={() => void disconnect()}
              >
                Disconnect
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => open("/settings/source-control")}>
                Manage on the web
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
