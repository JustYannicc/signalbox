import { useRef, useState } from "react";

import { APP_BASE_NAME } from "../branding";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Spinner } from "../components/ui/spinner";
import { SignInFrame, SignInNotice } from "./SignInFrame";
import { normalizeCode, submitVerifyEmailCode, type VerifyRequest } from "./verifyEmail";

/**
 * "Check your email": the provider signed in, but WorkOS wants the emailed
 * code first. Also loads in desktop's system browser and mobile's auth sheet,
 * so it stands alone and fits a phone.
 */
export function VerifyEmailScreen({ request }: { readonly request: VerifyRequest }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [invalidCode, setInvalidCode] = useState(false);
  const [ended, setEnded] = useState<"expired" | "failed" | null>(null);

  if (ended) {
    return (
      <SignInFrame title={ended === "expired" ? "That code expired" : "Sign-in didn't work"}>
        <SignInNotice error={ended} />
        <p className="mt-3 text-sm text-pretty text-muted-foreground">
          If you started in the {APP_BASE_NAME} app, start again there.
        </p>
        <div className="mt-6 grid">
          <Button size="lg" onClick={() => window.location.assign("/sign-in")}>
            Start over
          </Button>
        </div>
      </SignInFrame>
    );
  }

  const submit = async () => {
    const normalized = normalizeCode(code);
    if (!normalized || pending) {
      inputRef.current?.focus();
      return;
    }
    setPending(true);
    setInvalidCode(false);
    const outcome = await submitVerifyEmailCode(window.location.origin, {
      verify: request.verify,
      code: normalized,
    });
    if (outcome._tag === "next") {
      // Leaving the page; stay pending so nothing flickers back.
      window.location.assign(outcome.next);
      return;
    }
    setPending(false);
    if (outcome.error === "invalid-code") {
      setInvalidCode(true);
      inputRef.current?.select();
      return;
    }
    setEnded(outcome.error);
  };

  return (
    <SignInFrame
      title="Check your email"
      focusHeading={false}
      description={
        request.email ? `We sent a code to ${request.email}.` : "We sent you a code by email."
      }
    >
      <form
        className="mt-6 grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Label htmlFor="verify-email-code">Code</Label>
        <Input
          ref={inputRef}
          id="verify-email-code"
          nativeInput
          size="lg"
          font="mono"
          name="code"
          autoComplete="one-time-code"
          inputMode="numeric"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          required
          readOnly={pending}
          value={code}
          aria-invalid={invalidCode || undefined}
          aria-describedby={invalidCode ? "verify-email-code-error" : undefined}
          onChange={(event) => {
            setCode(event.currentTarget.value);
            if (invalidCode) setInvalidCode(false);
          }}
        />
        {invalidCode ? (
          <p id="verify-email-code-error" className="text-sm text-destructive" role="alert">
            That code didn't work. Check it and try again.
          </p>
        ) : null}
        <Button type="submit" size="lg" disabled={pending} aria-busy={pending}>
          {pending ? <Spinner aria-hidden /> : null}
          Continue
        </Button>
      </form>
    </SignInFrame>
  );
}
