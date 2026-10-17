/**
 * Settings → Sign-in (#575): where agents may sign in from the person's own
 * 1Password without asking. "Everywhere" is the grant for every site; the
 * rest are sites, each covering the addresses under it. Revoking stops the
 * next sign-in. "Try a site" shows the answer agents get, from the same
 * check the login service runs.
 *
 * @module SignInSettings
 */
import { useAtomValue } from "@effect/atom-react";
import {
  personalSignIn,
  signInCheckShown,
  signInFailureMessage,
} from "@t3tools/client-runtime/state/signalboxSignIn";
import type { EnvironmentId } from "@t3tools/contracts";
import { SIGN_IN_EVERYWHERE, type SignInGrant } from "@t3tools/contracts/signalboxSignIn";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useId, useState, type FormEvent } from "react";

import { formatEnvironmentQueryError } from "~/state/query";
import { signalboxSignIn, useSignInGrantsEnvironmentId } from "~/state/signalboxSignIn";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";

const PERSON = { _tag: "person" } as const;

const since = (at: number) => formatRelativeTimeLabel(new Date(at).toISOString());

export function SignInSettingsPanel() {
  const environmentId = useSignInGrantsEnvironmentId();
  return (
    <SettingsPageContainer>
      {environmentId === null ? (
        <SettingsSection title="Signing in">
          <SettingsRow
            title="Sign-in grants"
            description="Connect to Signalbox Cloud to choose where agents sign in as you."
          />
        </SettingsSection>
      ) : (
        <SignInGrantsSection key={environmentId} environmentId={environmentId} />
      )}
    </SettingsPageContainer>
  );
}

function SignInGrantsSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const result = useAtomValue(signalboxSignIn.grants({ environmentId, input: {} }));
  const list = Option.getOrNull(AsyncResult.value(result));
  const canChange = useAtomValue(signalboxSignIn.grant.permissionAtom(environmentId));
  const grant = useAtomCommand(signalboxSignIn.grant, { reportFailure: false });
  const revoke = useAtomCommand(signalboxSignIn.revoke, { reportFailure: false });
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "Allowed 3m ago"; a minute is fine-grained enough.
  useRelativeTimeTick(60_000);

  const run = async (key: string, command: () => Promise<string | null>) => {
    setPending(key);
    setError(null);
    const failure = await command();
    setError(failure);
    setPending(null);
    return failure === null;
  };
  const allow = (key: "everywhere" | "add", site: string) =>
    run(key, async () =>
      signInFailureMessage(await grant({ environmentId, input: { source: PERSON, site } })),
    );
  const stop = (granted: SignInGrant) =>
    run(granted.id, async () =>
      signInFailureMessage(await revoke({ environmentId, input: { id: granted.id } })),
    );

  if (list === null) {
    return (
      <SettingsSection title="Signing in">
        <SettingsRow
          title="Sign in everywhere"
          status={
            result._tag === "Failure" ? (
              <span role="alert" className="text-destructive">
                Couldn't load your sign-in grants: {formatEnvironmentQueryError(result.cause)}
              </span>
            ) : (
              "Loading…"
            )
          }
        />
      </SettingsSection>
    );
  }

  const { everywhere, sites } = personalSignIn(list);
  const busy = pending !== null || !canChange;

  return (
    <SettingsSection id="sign-in-grants" title="Signing in">
      <SettingsRow
        title="Sign in everywhere"
        description="Agents sign in to any site from your 1Password without asking you first. Payments always come back to you."
        status={everywhere === null ? undefined : `On since ${since(everywhere.grantedAt)}`}
        control={
          <Switch
            checked={everywhere !== null}
            disabled={busy}
            aria-label="Sign in everywhere"
            onCheckedChange={(checked) =>
              void (checked
                ? allow("everywhere", SIGN_IN_EVERYWHERE)
                : everywhere && stop(everywhere))
            }
          />
        }
      />
      <SettingsRow
        title="Sites"
        description={
          everywhere === null
            ? "Agents sign in to these, and the addresses under them, without asking. Anywhere else they ask you first, and Always adds the site here."
            : "These stay allowed if you switch everywhere off."
        }
        status={
          error === null ? undefined : (
            <span role="alert" className="text-destructive">
              {error}
            </span>
          )
        }
      >
        <AddSite disabled={busy} adding={pending === "add"} onAdd={(site) => allow("add", site)} />
      </SettingsRow>
      {sites.map((granted) => (
        <SettingsRow
          key={granted.id}
          title={granted.site}
          description={`Allowed ${since(granted.grantedAt)}`}
          control={
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void stop(granted)}>
              {pending === granted.id ? "Revoking…" : "Revoke"}
            </Button>
          }
        />
      ))}
      <TrySite environmentId={environmentId} />
    </SettingsSection>
  );
}

function AddSite(props: {
  readonly disabled: boolean;
  readonly adding: boolean;
  readonly onAdd: (site: string) => Promise<boolean>;
}) {
  const id = useId();
  const [site, setSite] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (site.trim().length === 0) return;
    if (await props.onAdd(site)) setSite("");
  };
  return (
    <form className="flex gap-2 pb-3" onSubmit={(event) => void submit(event)}>
      <label htmlFor={id} className="sr-only">
        Site to allow
      </label>
      <Input
        id={id}
        size="sm"
        autoComplete="off"
        spellCheck={false}
        inputMode="url"
        placeholder="booking.com"
        value={site}
        disabled={props.disabled}
        onChange={(event) => setSite(event.target.value)}
      />
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={props.disabled || site.trim() === ""}
      >
        {props.adding ? "Allowing…" : "Allow"}
      </Button>
    </form>
  );
}

/** The answer the login service gives for a site, as agents would get it. */
function TrySite({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const id = useId();
  const check = useAtomCommand(signalboxSignIn.check, { reportFailure: false });
  const [site, setSite] = useState("");
  const [answer, setAnswer] = useState<{ readonly text: string; readonly failed: boolean } | null>(
    null,
  );
  const [checking, setChecking] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const origin = site.trim();
    if (origin.length === 0) return;
    setChecking(true);
    const result = await check({ environmentId, input: { source: PERSON, origin } });
    const shown = signInCheckShown(origin, result);
    if (shown !== null) setAnswer(shown);
    setChecking(false);
  };
  return (
    <SettingsRow
      title="Try a site"
      description="See whether agents would sign in or ask you first."
    >
      <form className="flex gap-2 pb-2" onSubmit={(event) => void submit(event)}>
        <label htmlFor={id} className="sr-only">
          Site to try
        </label>
        <Input
          id={id}
          size="sm"
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
          placeholder="https://accounts.example.com"
          value={site}
          onChange={(event) => {
            setSite(event.target.value);
            setAnswer(null);
          }}
        />
        <Button type="submit" size="sm" variant="outline" disabled={checking || site.trim() === ""}>
          {checking ? "Checking…" : "Check"}
        </Button>
      </form>
      {answer === null ? null : (
        <p
          role={answer.failed ? "alert" : "status"}
          className={
            answer.failed ? "pb-3 text-xs text-destructive" : "pb-3 text-xs text-muted-foreground"
          }
        >
          {answer.text}
        </p>
      )}
    </SettingsRow>
  );
}
