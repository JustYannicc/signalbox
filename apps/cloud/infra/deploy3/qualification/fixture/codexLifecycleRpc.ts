import { readRpcData, withRpcStub } from "../../../../src/rpc/Resources.ts";
import type { QualifierExecutionContext } from "./proofContext.ts";
import type { QualifierEnvironment } from "./environment.ts";

type Shard = ReturnType<QualifierExecutionContext["shard"]>;
type Placement = ReturnType<QualifierEnvironment["PLACEMENT_STORES"]["getByName"]>;

/** Lifecycle RPCs return detached records. Lookup stubs never become retained scenario state. */
export function codexLifecycleRpc(owner: QualifierExecutionContext) {
  return {
    shard<A>(run: (shard: Shard) => A) {
      return withRpcStub(owner.shard(), (shard) => readRpcData(run(shard)));
    },
    placement<A>(run: (placement: Placement) => A) {
      return withRpcStub(
        owner.environment().PLACEMENT_STORES.getByName(owner.shardOwner()),
        (placement) => readRpcData(run(placement)),
      );
    },
    waitForFinish(runId: string, requestId: string) {
      return withRpcStub(owner.environment().HARNESS_RUN_STORE.getByName(runId), (store) =>
        readRpcData(store.waitForFinish(requestId)),
      );
    },
  };
}
