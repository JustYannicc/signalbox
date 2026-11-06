import { disposeWorkerLoaderStubs } from "../../../../src/computer/WorkerLoaderDispatch.ts";
import { readRpcData, rpcStubOwner } from "../../../../src/rpc/Resources.ts";
import { assert } from "./common.ts";
import { proof, type QualifierEnvironment } from "./environment.ts";
import {
  claudeObserverCalibrationCode,
  OBSERVER_CALIBRATION_FACET,
} from "./observerCalibrationFacet.ts";

type CalibrationFacet = Rpc.DurableObjectBranded & {
  identity(): Promise<{ facetNonce: string }>;
  observerCalibration(input: {
    invocationId: string;
  }): Promise<{ incarnation: string; invocationId: string; nativeStarted: false }>;
};

/** Proves the real loader, observer shim and tail before any Claude dispatch, through the same platform path. */
export async function calibrateClaudeObserver(ctx: DurableObjectState, env: QualifierEnvironment) {
  const key = `claude-observer-calibration-${env.RUN_ID}`;
  const cap = proof(env);
  using _capOwner = rpcStubOwner(cap);
  const worker = env.LOADER.get(key, () =>
    claudeObserverCalibrationCode(env.RUN_ID, key, env.QUALIFIER_TAIL),
  );
  const type = worker.getDurableObjectClass<CalibrationFacet>(OBSERVER_CALIBRATION_FACET);
  const facet = ctx.facets.get<CalibrationFacet>(key, () => ({ class: type }));
  try {
    const identity = await readRpcData(facet.identity());
    const observed = await readRpcData(facet.observerCalibration({ invocationId: key }));
    assert(
      observed.incarnation === identity.facetNonce && observed.nativeStarted === false,
      "Claude observer calibration changed its identity or started native execution",
    );
    await readRpcData(cap.append("claude-observer-calibration-returned", { identity, observed }));
    return { identity, observed, loaderId: key, nativeStarted: false as const };
  } finally {
    try {
      ctx.facets.abort(key, "Claude observer calibration completed without native execution");
      ctx.facets.delete(key);
    } finally {
      disposeWorkerLoaderStubs(worker);
    }
  }
}
