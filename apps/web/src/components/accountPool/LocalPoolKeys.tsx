import type { ClientOs, EnvironmentId } from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { useCallback, useEffect, useState } from "react";

import { browserClientOs } from "../../connection/clientMetadata";
import { useIsSignalboxCloud } from "../../github/CloudGitHubSettings";
import { useAccountPools } from "../../state/accountPools";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { CommandBlock } from "../CommandBlock";
import { SettingsRow, SettingsSection, useRelativeTimeTick } from "../settings/settingsLayout";
import { Button } from "../ui/button";

/**
 * Settings → Pools in Signalbox Cloud: run Claude Code and Codex on your own
 * computer with your pool. Making a key answers one command that checks it
 * and writes both harnesses' config (`apps/cloud/src/localKeys/`). The
 * harnesses then call the cloud's model endpoint with the key; no Signalbox
 * client is involved. Keys are managed with the cloud's session, so this runs
 * on the cloud's own web app; elsewhere it links to that page.
 */

interface LocalKey {
  readonly id: string;
  readonly label: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly requests: number;
  readonly tokens: number;
}

interface LocalKeysView {
  readonly keys: ReadonlyArray<LocalKey>;
  readonly poolId: string | null;
  readonly available: boolean;
}

const COMPUTER_LABELS: Partial<Record<ClientOs, string>> = {
  macOS: "Mac",
  Windows: "Windows PC",
  Linux: "Linux computer",
  ChromeOS: "Chromebook",
};

/** What the browser says it runs on, to tell computers apart. */
function computerLabel() {
  const os = browserClientOs({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
  });
  return COMPUTER_LABELS[os] ?? "Computer";
}

const ERROR_FALLBACK = "Couldn't reach Signalbox. Try again.";

async function errorMessage(response: Response) {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? ERROR_FALLBACK;
}

export function LocalPoolKeys({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const isCloud = useIsSignalboxCloud(environmentId);
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  if (!isCloud || httpBaseUrl === null) return null;
  const pageUrl = (path: string) => new URL(path, httpBaseUrl);
  const baseUrl = pageUrl("/");
  if (baseUrl.origin !== window.location.origin) {
    return (
      <SettingsSection id="local-keys" title="On your computer">
        <SettingsRow
          title="Claude Code and Codex on your pool"
          description="Run them on your own computer with your pool's accounts. Set it up from Signalbox on the web."
          control={
            <Button
              size="sm"
              variant="outline"
              render={<a href={pageUrl("/settings/pools").href} target="_blank" rel="noreferrer" />}
            >
              Set up on the web
            </Button>
          }
        />
      </SettingsSection>
    );
  }
  return <LocalKeysSection environmentId={environmentId} baseUrl={baseUrl.href} />;
}

function LocalKeysSection({
  environmentId,
  baseUrl,
}: {
  readonly environmentId: EnvironmentId;
  readonly baseUrl: string;
}) {
  const pageUrl = (path: string) => new URL(path, baseUrl);
  const pools = useAccountPools(environmentId);
  const [view, setView] = useState<LocalKeysView | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Labels read "3m ago"; a minute is fine-grained enough.
  useRelativeTimeTick(60_000);

  const load = useCallback(async () => {
    const response = await fetch(new URL("/api/local-keys", baseUrl), {
      credentials: "include",
    }).catch(() => null);
    if (response?.ok) setView((await response.json()) as LocalKeysView);
  }, [baseUrl]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- State changes only after the response arrives.
    void load();
    // A computer set up in a terminal shows its first use when you come back.
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const send = async (
    request: () => Promise<Response>,
    onOk: (response: Response) => Promise<void>,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const response = await request();
      if (response.ok) await onOk(response);
      else setError(await errorMessage(response));
    } catch {
      setError(ERROR_FALLBACK);
    } finally {
      setBusy(false);
      await load();
    }
  };

  const setUp = () =>
    send(
      () =>
        fetch(pageUrl("/api/local-keys"), {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: computerLabel() }),
        }),
      async (response) => setCommand(((await response.json()) as { command: string }).command),
    );

  const revoke = (id: string) =>
    send(
      () => fetch(pageUrl(`/api/local-keys/${id}`), { method: "DELETE", credentials: "include" }),
      // The command it showed no longer works.
      async () => setCommand(null),
    );

  if (view === null || !view.available) return null;
  const pool = pools.find((candidate) => candidate.id === view.poolId);
  const poolText =
    view.poolId === null
      ? "Your top level has no pool, so keys can't run anything until it has one."
      : `They run on ${pool === undefined ? "your top level's pool" : `${pool.name}, your top level's pool`}, and count toward its usage.`;

  return (
    <SettingsSection
      id="local-keys"
      title="On your computer"
      headerAction={
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void setUp()}>
          Set up a computer
        </Button>
      }
    >
      <SettingsRow
        title="Claude Code and Codex on your pool"
        description={`Your computer's Claude Code and Codex use your pool instead of your own logins. ${poolText}`}
        status={error === null ? undefined : <span className="text-destructive">{error}</span>}
      >
        {command === null ? null : (
          <div className="space-y-2 pt-1 pb-3">
            <p className="text-xs text-muted-foreground">
              Run this in a terminal on that computer. It checks the key, then writes both
              harnesses' settings. Add <code>--undo</code> instead of the key to go back.
            </p>
            <CommandBlock command={command} />
          </div>
        )}
      </SettingsRow>
      {view.keys.map((key) => (
        <SettingsRow
          key={key.id}
          title={key.label}
          description={
            key.lastUsedAt === null
              ? "Not used yet"
              : `Used ${formatRelativeTimeLabel(new Date(key.lastUsedAt).toISOString())} · ${formatTokens(key.tokens)} tokens in ${key.requests.toLocaleString()} requests`
          }
          control={
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void revoke(key.id)}>
              Revoke
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );
}
