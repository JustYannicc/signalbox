import { useAtomValue } from "@effect/atom-react";
import { ChartNoAxesColumnIcon } from "lucide-react";

import { hasLimitProblemsAtom } from "../../state/limitProblems";

/** The Usage nav icon, with a red dot while an account needs a new sign-in or a hub is down. */
export function UsageNavIcon() {
  const attention = useAtomValue(hasLimitProblemsAtom);
  if (!attention) return <ChartNoAxesColumnIcon />;
  return (
    <span className="relative grid size-4 place-items-center">
      <ChartNoAxesColumnIcon className="size-4" />
      <span
        aria-hidden="true"
        className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-destructive ring-2 ring-sidebar"
      />
      <span className="sr-only">An account needs attention</span>
    </span>
  );
}
