import { CircleCheckIcon, PiggyBankIcon, TriangleAlertIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { notifyAccountsComingSoon } from "./accountPoolsModel";
import type { UsageAdvice } from "./usageAdvice";

const TONE = {
  warning: { icon: TriangleAlertIcon, className: "text-warning-foreground" },
  saving: { icon: PiggyBankIcon, className: "text-info-foreground" },
  ok: { icon: CircleCheckIcon, className: "text-muted-foreground" },
} as const;

/** One line per harness: what your pace means and the one thing to do about it. */
export function UsageAdviceList({ advice }: { readonly advice: readonly UsageAdvice[] }) {
  return (
    <section aria-labelledby="usage-advice" className="flex flex-col gap-2">
      <h2 id="usage-advice" className="text-sm font-medium text-foreground">
        Based on your usage
      </h2>
      <ul className="flex flex-col gap-1">
        {advice.map((entry) => {
          const tone = TONE[entry.tone];
          const Icon = tone.icon;
          return (
            <li key={entry.harness} className="flex min-h-8 items-center gap-2.5 text-sm">
              <Icon className={cn("size-4 shrink-0", tone.className)} aria-hidden />
              <span className="min-w-0 flex-1 text-foreground">
                {entry.text}
                {entry.action ? (
                  <span className="text-muted-foreground"> · {entry.action.detail}</span>
                ) : null}
              </span>
              {entry.action ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => notifyAccountsComingSoon(entry.action?.label ?? "This")}
                >
                  {entry.action.label}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
