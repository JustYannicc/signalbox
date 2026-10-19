// @effect-diagnostics nodeBuiltinImport:off - the local CLI bounds readiness of its temporary dev tunnel before starting a machine.
import * as NodeTimersPromises from "node:timers/promises";
import { ProofLauncherFailure, requestProofWorker, workerEvidence } from "./Deployment.ts";

export async function waitForDevTunnel(
  input: {
    readonly url: URL;
    readonly token: string;
    readonly stage: string;
    readonly signal: AbortSignal;
  },
  request = requestProofWorker,
) {
  while (!input.signal.aborted) {
    try {
      const response = await request({
        url: input.url,
        token: input.token,
        route: "/status",
        method: "GET",
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(5_000)]),
      });
      const evidence = workerEvidence(response.body, input.stage);
      if (evidence.status !== "pending")
        throw new ProofLauncherFailure("The dev tunnel reached a proof that already started.");
      return;
    } catch (error) {
      if (input.signal.aborted) break;
      if (
        !(error instanceof ProofLauncherFailure) ||
        !/network error|was interrupted|HTTP (?:404|429|5\d\d)/u.test(error.safeMessage)
      )
        throw error;
    }
    await NodeTimersPromises.setTimeout(2_000, undefined, { signal: input.signal }).catch(
      () => undefined,
    );
  }
  throw new ProofLauncherFailure("The dev tunnel did not become reachable before the deadline.");
}
