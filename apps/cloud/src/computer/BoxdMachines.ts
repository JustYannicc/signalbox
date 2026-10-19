/** Public Computer entry point for the private Boxd machine adapter. */
export {
  BoxdMachinePendingError,
  boxdMachineClient,
  makeBoxdMachines,
} from "./adapters/BoxdMachines.ts";
export type {
  BoxdMachineClient,
  BoxdMachineRecord,
  BoxdMachineReservation,
  BoxdMachineReservationLookup,
  BoxdMachineReservations,
  BoxdMachinesConfig,
} from "./adapters/BoxdMachines.ts";
