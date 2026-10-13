/**
 * Settings → Integrations → Connected services: the Executor connection that
 * automations reach the user's accounts through with `w.call`. One environment
 * at a time, the one the settings header selects.
 *
 * @module ConnectedServicesSettings
 */
import type { AutomationConnectionStatus, EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  groupConnectedServices,
  type ConnectedServiceGroup,
} from "@t3tools/client-runtime/automations/connectedServices";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { ExternalLinkIcon, PlugIcon } from "lucide-react";
import { useState } from "react";

import { faviconUrlForOrigin } from "~/lib/favicon";
import { automationState } from "~/state/automations";
import { useAtomCommand } from "~/state/use-atom-command";

import { GitHubIcon } from "../Icons";
import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";

const EXECUTOR_HOME = "https://executor.sh";

/** The URL's host for display; env-var URLs aren't normalized, so a bad one shows as is. */
const hostOf = (url: string | null) => {
  if (!url) return "Executor";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const messageOf = (error: unknown) =>
  error instanceof Error || (typeof error === "object" && error !== null && "message" in error)
    ? String((error as { message: unknown }).message)
    : "Something went wrong.";

export function ConnectedServicesSettings() {
  const { environment, connectedEnvironments } = useSettingsScope();
  const connected = environment?.connection.phase === "connected" && environment.serverConfig;
  return (
    <SettingsSection {...searchableSetting("connected-services")}>
      {connected ? (
        <ExecutorConnection
          key={environment.environmentId}
          environmentId={environment.environmentId}
          environmentLabel={connectedEnvironments.length > 1 ? environment.label : null}
        />
      ) : (
        <SettingsRow
          title="Executor"
          description="Connect to an environment to see the services its automations can use."
        />
      )}
    </SettingsSection>
  );
}

function ExecutorConnection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
}) {
  const result = useAtomValue(
    automationState.connectionStatus({ environmentId: props.environmentId, input: {} }),
  );
  const status = Option.getOrNull(AsyncResult.value(result));
  const loadError =
    status === null && result._tag === "Failure" ? messageOf(Cause.squash(result.cause)) : null;
  const disconnect = useAtomCommand(automationState.disconnect, { reportFailure: false });
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const description = (
    <>
      Automations use these accounts through <code className="font-mono">w.call</code>. Executor
      holds the logins; {props.environmentLabel ?? "this server"} keeps only Executor's key.
    </>
  );

  if (status === null) {
    return (
      <SettingsRow
        title="Executor"
        description={description}
        status={
          loadError ? (
            <span role="alert" className="text-destructive">
              Couldn't load connected services: {loadError}
            </span>
          ) : (
            "Checking…"
          )
        }
      />
    );
  }

  const envManaged = status.source === "environment";
  const showForm = !status.configured || editing;
  const groups = groupConnectedServices(status.services);

  return (
    <>
      <SettingsRow
        title="Executor"
        description={description}
        status={<ConnectionStatusLine status={status} />}
        control={
          status.configured && status.url ? (
            <>
              <Button
                size="sm"
                variant="outline"
                render={<a href={status.url} target="_blank" rel="noreferrer noopener" />}
              >
                Manage connections in Executor
                <ExternalLinkIcon aria-hidden />
              </Button>
              {envManaged ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    setPending(true);
                    setActionError(null);
                    void disconnect({ environmentId: props.environmentId, input: {} })
                      .then((outcome) => {
                        if (outcome._tag === "Failure")
                          setActionError(messageOf(squashAtomCommandFailure(outcome)));
                        else setEditing(false);
                      })
                      .finally(() => setPending(false));
                  }}
                >
                  {pending ? "Disconnecting…" : "Disconnect"}
                </Button>
              )}
            </>
          ) : null
        }
      >
        {actionError ? (
          <p role="alert" className="pb-2 text-xs text-destructive">
            {actionError}
          </p>
        ) : null}
        {status.configured && !envManaged && !editing ? (
          <div className="pb-2">
            <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
              {status.error ? "Update URL or key" : "Change URL or key"}
            </Button>
          </div>
        ) : null}
      </SettingsRow>
      {showForm && !envManaged ? (
        <ConnectForm
          environmentId={props.environmentId}
          initialUrl={status.url ?? ""}
          onCancel={status.configured ? () => setEditing(false) : null}
          onConnected={() => setEditing(false)}
        />
      ) : null}
      {status.configured && !status.error ? (
        groups.length > 0 ? (
          groups.map((group) => <ServiceRow key={group.integration} group={group} />)
        ) : (
          <SettingsRow
            title="Nothing connected yet"
            description="Connect Gmail, GitHub, Linear and more in Executor. They show up here, ready for w.call."
          />
        )
      ) : null}
    </>
  );
}

function ConnectionStatusLine({ status }: { readonly status: AutomationConnectionStatus }) {
  if (!status.configured) return <span>Not connected</span>;
  const host = hostOf(status.url);
  if (status.error)
    return (
      <span role="alert" className="text-destructive">
        {status.error}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className="size-1.5 rounded-full bg-success" />
      Connected to {host}
      {status.source === "environment" ? " · set by this server's environment variables" : ""}
    </span>
  );
}

function ConnectForm(props: {
  readonly environmentId: EnvironmentId;
  readonly initialUrl: string;
  readonly onCancel: (() => void) | null;
  readonly onConnected: () => void;
}) {
  const connect = useAtomCommand(automationState.connect, { reportFailure: false });
  const [url, setUrl] = useState(props.initialUrl);
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = url.trim() !== "" && apiKey.trim() !== "" && !pending;
  const urlId = `executor-url-${props.environmentId}`;
  const keyId = `executor-key-${props.environmentId}`;

  return (
    <form
      className="grid gap-3 px-3 py-3 sm:px-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        setPending(true);
        setError(null);
        void connect({ environmentId: props.environmentId, input: { url, apiKey } })
          .then((outcome) => {
            if (outcome._tag === "Failure") {
              setError(messageOf(squashAtomCommandFailure(outcome)));
              return;
            }
            setApiKey("");
            props.onConnected();
          })
          .finally(() => setPending(false));
      }}
    >
      <fieldset disabled={pending} className="contents">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={urlId}>Executor URL</Label>
            <Input
              id={urlId}
              size="sm"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder={EXECUTOR_HOME}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={keyId}>API key</Label>
            <Input
              id={keyId}
              size="sm"
              type="password"
              autoComplete="off"
              placeholder="Paste a key from Executor"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {error ? (
            <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
              {error}
            </p>
          ) : (
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              No Executor yet?{" "}
              <InlineButton
                render={<a href={EXECUTOR_HOME} target="_blank" rel="noreferrer noopener" />}
              >
                Get one at executor.sh
              </InlineButton>
              , connect your accounts there, then paste its URL and an API key.
            </p>
          )}
          <div className="flex items-center gap-2">
            {props.onCancel ? (
              <Button size="sm" variant="ghost" type="button" onClick={props.onCancel}>
                Cancel
              </Button>
            ) : null}
            <Button size="sm" type="submit" disabled={!canSubmit}>
              <PlugIcon aria-hidden />
              {pending ? "Checking…" : "Connect"}
            </Button>
          </div>
        </div>
      </fieldset>
    </form>
  );
}

function ServiceRow({ group }: { readonly group: ConnectedServiceGroup }) {
  return (
    <SettingsRow
      title={
        <span className="inline-flex items-center gap-2">
          <ServiceFavicon domain={group.domain} />
          {group.label}
        </span>
      }
      description={
        <>
          <code className="font-mono">{group.integration}</code>
          {group.accounts.length > 1
            ? ` · pass { connection: "${group.accounts[0]}" } to pick an account`
            : null}
        </>
      }
      control={
        <span className="truncate text-xs text-muted-foreground">{group.accounts.join(", ")}</span>
      }
    />
  );
}

/** Domains whose favicon already failed this session go straight to the fallback. */
const failedDomains = new Set<string>();

function ServiceFavicon({ domain }: { readonly domain: string }) {
  const [failed, setFailed] = useState(() => failedDomains.has(domain));
  const url = faviconUrlForOrigin(`https://${domain}`, 64);
  if (domain === "github.com") return <GitHubIcon aria-hidden className="size-4" />;
  if (!url || failed) return <PlugIcon aria-hidden className="size-4 text-muted-foreground" />;
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      draggable={false}
      className="size-4 rounded-sm"
      onError={() => {
        failedDomains.add(domain);
        setFailed(true);
      }}
    />
  );
}
