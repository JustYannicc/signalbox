import type { AccountSignInError } from "@t3tools/contracts/account";
import { useCallback, type ReactNode } from "react";

import { SignalboxLogo } from "../components/SignalboxMark";
import { Alert, AlertDescription } from "../components/ui/alert";
import { StandalonePage } from "../components/ui/standalone-page";

/** The sign-in screen's shell and its error line; state lives in `SignInScreen`. */

const ERROR_COPY: Record<AccountSignInError, string> = {
  cancelled: "Sign-in cancelled.",
  expired: "That sign-in is no longer valid. Start again.",
  failed: "Something went wrong signing in. Try again.",
};

export function SignInFrame({
  title,
  description,
  focusHeading: shouldFocusHeading = true,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  /** Off when a field inside should take focus instead. */
  readonly focusHeading?: boolean;
  readonly children?: ReactNode;
}) {
  // Each state swap unmounts the focused control; land focus (and screen
  // readers) on the new heading instead of <body>.
  // Keyed by title, so this runs once per state.
  const focusHeading = useCallback(
    (heading: HTMLHeadingElement | null) => {
      if (shouldFocusHeading) heading?.focus({ preventScroll: true });
    },
    [shouldFocusHeading],
  );

  return (
    <StandalonePage tone="brand">
      <SignalboxLogo className="text-lg text-foreground" />
      <h1
        key={title}
        ref={focusHeading}
        tabIndex={-1}
        className="mt-8 text-2xl font-semibold tracking-tight text-balance outline-none sm:text-3xl"
      >
        {title}
      </h1>
      {description ? (
        <p className="mt-2 text-sm leading-relaxed text-pretty text-muted-foreground">
          {description}
        </p>
      ) : null}
      {children}
    </StandalonePage>
  );
}

export function SignInNotice({ error }: { readonly error: AccountSignInError }) {
  // Backing out at the provider is a choice, not a failure: say so quietly.
  if (error === "cancelled") {
    return (
      <p className="mt-4 text-sm text-muted-foreground" role="status">
        {ERROR_COPY.cancelled}
      </p>
    );
  }
  return (
    <div className="mt-4">
      <Alert variant="error">
        <AlertDescription>{ERROR_COPY[error]}</AlertDescription>
      </Alert>
    </div>
  );
}
