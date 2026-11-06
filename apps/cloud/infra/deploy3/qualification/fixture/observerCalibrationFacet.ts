import { observeWorkerCode, type ObserverLoaderPin } from "./loaderObservation.ts";

export const CLAUDE_OBSERVER_CALIBRATION_PATH = "/claude/observer-calibration";
export const OBSERVER_CALIBRATION_FACET = "ObserverCalibrationFacet";
const MAIN = "qualifier-observer-calibration.mjs";

/** Imports no harness, engine or kernel, so calibrating the observer costs a Claude run no lane's memory. */
export const OBSERVER_CALIBRATION_FACET_SOURCE = `import { DurableObject } from "cloudflare:workers";
export class ${OBSERVER_CALIBRATION_FACET} extends DurableObject {
  facetNonce = crypto.randomUUID();
  identity() {
    return { facetNonce: this.facetNonce };
  }
  observerCalibration(input) {
    return { incarnation: this.facetNonce, invocationId: input.invocationId, nativeStarted: false };
  }
}
`;

function pin(loaderId: string): ObserverLoaderPin {
  const route = { method: "POST", path: CLAUDE_OBSERVER_CALIBRATION_PATH };
  return {
    loaderId,
    role: "facet",
    entrypoint: OBSERVER_CALIBRATION_FACET,
    identity: "facet:claude-observer-calibration",
    tag: "observer-calibration-facet",
    calls: {
      identity: [{ callId: "*", route }],
      isolateNonceProbe: [{ callId: "*", route }],
      // The proof's tail barrier waits for a terminal event carrying exactly the loader ID.
      observerCalibration: [{ callId: loaderId, route }],
    },
  };
}

export function claudeObserverCalibrationCode(runId: string, loaderId: string, tail: Fetcher) {
  return observeWorkerCode(
    {
      compatibilityDate: "2026-10-19",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: MAIN,
      modules: { [MAIN]: { js: OBSERVER_CALIBRATION_FACET_SOURCE } },
      globalOutbound: null,
    },
    runId,
    pin(loaderId),
    tail,
  ).code;
}
