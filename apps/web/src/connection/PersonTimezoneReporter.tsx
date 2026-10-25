import { useAtomValue } from "@effect/atom-react";
import {
  connectedPersonTimezoneEnvironmentIds,
  createPersonTimezoneReportPermissionsAtom,
  permittedPersonTimezoneEnvironmentIds,
  PersonTimezoneReportCoordinator,
} from "@t3tools/client-runtime/personTimezone";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef } from "react";

import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironments } from "../state/environments";
import { personTimezone } from "../state/personTimezone";
import { useStableCallback } from "../hooks/useStableCallback";

export function PersonTimezoneReporter() {
  const { environments } = useEnvironments();
  const report = useAtomCommand(personTimezone.report, {
    reportFailure: false,
    reportDefect: false,
  });
  const coordinator = useRef(new PersonTimezoneReportCoordinator<EnvironmentId>());
  const connectedEnvironmentIds = connectedPersonTimezoneEnvironmentIds(environments);
  const reportPermissionsAtom = createPersonTimezoneReportPermissionsAtom(
    connectedEnvironmentIds,
    personTimezone.report.permissionAtom,
  );
  const reportPermissions = useAtomValue(reportPermissionsAtom);
  const permittedEnvironmentIds = permittedPersonTimezoneEnvironmentIds(
    connectedEnvironmentIds,
    reportPermissions,
  );
  const sendReport = useStableCallback((environmentId: EnvironmentId, timezone: string) =>
    report({ environmentId, input: { timezone } }).then((result) => !AsyncResult.isFailure(result)),
  );

  useEffect(() => {
    coordinator.current.setActiveEnvironmentIds(permittedEnvironmentIds, sendReport);
  }, [permittedEnvironmentIds, sendReport]);

  useEffect(() => {
    const reportOnForeground = () => {
      if (document.visibilityState !== "visible") return;
      coordinator.current.reportOnForeground(sendReport);
    };
    window.addEventListener("focus", reportOnForeground);
    document.addEventListener("visibilitychange", reportOnForeground);
    return () => {
      window.removeEventListener("focus", reportOnForeground);
      document.removeEventListener("visibilitychange", reportOnForeground);
    };
  }, [sendReport]);

  return null;
}
