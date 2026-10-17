import type { RecoveryEvidence } from "./RecoveryEvidence.ts";
import type { RecoveryDrillExpected, RecoveryDrillHost } from "./RecoveryDrillProtocol.ts";
import { makeRecoveryDrillMachineInspector } from "./RecoveryDrillMachineInspection.ts";
import { makeRecoveryDrillMachineKiller } from "./RecoveryDrillMachineKill.ts";

export const makeRecoveryDrillMachineActions = (options: {
  readonly host: RecoveryDrillHost;
  readonly enabled: () => boolean;
  readonly incarnation: () => Promise<string>;
  readonly matches: (expected: RecoveryDrillExpected, evidence: RecoveryEvidence) => boolean;
}) => ({
  ...makeRecoveryDrillMachineInspector(options),
  ...makeRecoveryDrillMachineKiller(options),
});
