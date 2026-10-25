import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";

import type { MachineStartupProblem } from "./MachineBackend.ts";

export const MAX_STARTUP_RETRIES = 1;

export const startupFailure = (
  backend: string,
  timeoutMs: number,
  retries: number,
  problem?: MachineStartupProblem,
  timedOut = true,
): OrchestrationV2ProviderFailure => ({
  class: "provider_error",
  code:
    problem?.code ??
    (backend === "none" ? "machine_backend_not_configured" : "machine_start_timeout"),
  message: [
    problem?.message ??
      (backend === "none"
        ? "This server has no machine backend configured."
        : `The ${backend} machine's Runner did not connect.`),
    ...(timedOut
      ? [
          `Startup stopped after ${retries + 1} attempt${retries === 0 ? "" : "s"} of ${Math.round(timeoutMs / 1000)} s.`,
        ]
      : []),
    "The turn never reached a Runner.",
    ...((problem?.retryable ?? backend !== "none") ? ["Retry this turn."] : []),
  ].join(" "),
  retryable: problem?.retryable ?? backend !== "none",
});
