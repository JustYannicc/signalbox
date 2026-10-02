import { CheckIcon, CopyIcon } from "lucide-react";

import { useCopyWithToast } from "../setup/CopyableCode";
import { SETUP_PROMPT } from "../setup/setupFixtures";
import { Button } from "../ui/button";
import { SectionHeading } from "./teamPrimitives";

const STEPS: readonly { readonly title: string; readonly detail: string }[] = [
  { title: "Sign in", detail: "WorkOS, with company SSO for northwind.example addresses" },
  { title: "Join the team", detail: "From the invite, or automatically for the verified domain" },
  { title: "Connect your model accounts", detail: "Personal ones stay personal" },
  { title: "Paste the setup prompt into your agent", detail: "It installs and connects the rest" },
];

/** What a new teammate walks through, previewed for the person inviting them. */
export function SignUpFlowCard() {
  const { copyToClipboard, isCopied } = useCopyWithToast("setup prompt");
  return (
    <section aria-labelledby="team-signup" className="flex flex-col gap-3">
      <SectionHeading id="team-signup" title="Sign-up flow" note="What an invited person sees" />
      <ol className="flex flex-col gap-3 rounded-lg border border-border p-4">
        {STEPS.map((step, index) => (
          <li key={step.title} className="flex gap-3">
            <span
              aria-hidden
              className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-medium text-muted-foreground tabular-nums"
            >
              {index + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">{step.title}</span>
              <span className="text-xs text-muted-foreground">{step.detail}</span>
            </div>
          </li>
        ))}
        <li className="ps-8">
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              copyToClipboard(SETUP_PROMPT, {
                toastTitle: "Setup prompt copied",
                toastDescription: "Send it to the person you invited.",
              })
            }
          >
            {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
            {isCopied ? "Copied" : "Copy setup prompt"}
          </Button>
        </li>
      </ol>
    </section>
  );
}
