import type { AccountProvider } from "@t3tools/contracts/account";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Spinner } from "../components/ui/spinner";
import { ACCOUNT_PROVIDER_PRESENTATION } from "./accountProviders";

/**
 * Web: one "Continue with …" button per provider the server offers, then
 * email, which opens WorkOS's hosted page (password, email code, sign-up).
 */
export function WebSignInOptions({
  providers,
  pending,
  email,
  onEmailChange,
  onStart,
}: {
  readonly providers: ReadonlyArray<AccountProvider>;
  readonly pending: AccountProvider | null;
  readonly email: string;
  readonly onEmailChange: (email: string) => void;
  readonly onStart: (provider: AccountProvider) => void;
}) {
  const buttonProviders = providers.filter((provider) => provider !== "email");
  const offersEmail = providers.includes("email");
  const busy = pending !== null;

  if (providers.length === 0) {
    return (
      <p className="mt-4 text-sm text-muted-foreground">Sign-in isn't set up on this server yet.</p>
    );
  }

  return (
    <>
      {buttonProviders.length > 0 ? (
        <div className="mt-6 grid gap-2">
          {buttonProviders.map((provider) => {
            const { label, Icon } = ACCOUNT_PROVIDER_PRESENTATION[provider];
            return (
              <Button
                key={provider}
                size="lg"
                variant="outline"
                disabled={busy}
                aria-busy={pending === provider}
                onClick={() => onStart(provider)}
              >
                {pending === provider ? (
                  <Spinner aria-hidden />
                ) : Icon ? (
                  <Icon className="text-foreground" />
                ) : null}
                Continue with {label}
              </Button>
            );
          })}
        </div>
      ) : null}

      {offersEmail ? (
        <>
          {buttonProviders.length > 0 ? (
            <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" aria-hidden />
              or
              <span className="h-px flex-1 bg-border" aria-hidden />
            </div>
          ) : null}
          <form
            className={buttonProviders.length > 0 ? "grid gap-2" : "mt-6 grid gap-2"}
            onSubmit={(event) => {
              event.preventDefault();
              onStart("email");
            }}
          >
            <Label htmlFor="sign-in-email">Email</Label>
            <Input
              id="sign-in-email"
              nativeInput
              size="lg"
              type="email"
              name="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              required
              placeholder="you@example.com"
              value={email}
              disabled={busy}
              onChange={(event) => onEmailChange(event.currentTarget.value)}
            />
            <Button
              type="submit"
              size="lg"
              variant="outline"
              disabled={busy}
              aria-busy={pending === "email"}
            >
              {pending === "email" ? <Spinner aria-hidden /> : null}
              Continue with email
            </Button>
          </form>
        </>
      ) : null}
    </>
  );
}

export type DesktopScreenHint = "sign-up" | "sign-in";

const DESKTOP_SCREEN_HINTS: ReadonlyArray<DesktopScreenHint> = ["sign-up", "sign-in"];

/** Desktop: sign up or sign in, both finished in the system browser. */
export function DesktopSignInOptions({
  pending,
  onStart,
}: {
  readonly pending: DesktopScreenHint | null;
  readonly onStart: (screenHint: DesktopScreenHint) => void;
}) {
  return (
    <>
      <div className="mt-6 grid gap-2">
        {DESKTOP_SCREEN_HINTS.map((screenHint, index) => (
          <Button
            key={screenHint}
            size="lg"
            variant={index === 0 ? "default" : "outline"}
            disabled={pending !== null}
            aria-busy={pending === screenHint}
            onClick={() => onStart(screenHint)}
          >
            {pending === screenHint ? <Spinner aria-hidden /> : null}
            {screenHint === "sign-up" ? "Sign up" : "Sign in"}
          </Button>
        ))}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-pretty text-muted-foreground">
        Opens your browser, where your saved passwords and passkeys work.
      </p>
    </>
  );
}
