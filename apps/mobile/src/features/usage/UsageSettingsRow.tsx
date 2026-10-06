import { useAtomValue } from "@effect/atom-react";

import { hasLimitProblemsAtom } from "../../state/limitProblems";
import { SettingsRow } from "../settings/components/SettingsRow";

/** signalbox: the Settings → Usage row, dotted while an account needs a new sign-in or a hub is down. */
export function UsageSettingsRow() {
  const attention = useAtomValue(hasLimitProblemsAtom);
  return (
    <SettingsRow
      icon="chart.bar.xaxis"
      label="Usage"
      target="SettingsUsage"
      attention={attention}
    />
  );
}
