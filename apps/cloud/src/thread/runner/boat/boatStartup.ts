import type { MachineStartupProblem } from "../MachineBackend.ts";
import type { BoatApiError } from "./BoatApi.ts";

/** Keep provider response bodies out of the turn's user-facing error. */
export const boatStartupProblem = (error: BoatApiError): MachineStartupProblem => {
  if (error.code === "snapshot_data_expired") {
    return {
      code: "machine_snapshot_expired",
      message: "Boat can no longer restore this machine's expired disk snapshot.",
      retryable: false,
    };
  }
  if (error.status === 401 || error.status === 403) {
    return {
      code: "machine_access_denied",
      message: "Boat rejected this server's machine credentials or access.",
      retryable: false,
    };
  }
  if (error.status === 429) {
    return {
      code: "machine_rate_limited",
      message: "Boat is limiting machine requests. Try again later.",
      retryable: true,
    };
  }
  if (error.code === "command_failed") {
    return {
      code: "machine_setup_failed",
      message: "The machine's Runner setup command did not complete.",
      retryable: true,
    };
  }
  const retryable =
    error.status === 0 || error.status >= 500 || error.status === 408 || error.status === 409;
  return {
    code: retryable ? "machine_backend_unavailable" : "machine_request_rejected",
    message:
      error.status === 0
        ? "Boat did not answer the machine request."
        : `Boat rejected the machine request with HTTP ${error.status}.`,
    retryable,
  };
};
