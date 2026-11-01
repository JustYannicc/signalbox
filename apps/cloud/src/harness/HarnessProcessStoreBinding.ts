import { readRpcData, withRpcStub } from "../rpc/Resources.ts";
import { WorkerEntrypoint } from "cloudflare:workers";
import * as Schema from "effect/Schema";
import type { HarnessDurableStateBindings } from "./HarnessDurableState.ts";
import { ProcessFence } from "./processOwnership/fence.ts";

const BindingProps = Schema.Struct({
  runId: Schema.NonEmptyString,
  store: Schema.Literals(["runStore", "filesStore", "threadSupervisor"]),
  fence: ProcessFence,
});
const readBindingProps = Schema.decodeUnknownSync(BindingProps, { onExcessProperty: "error" });
export type HarnessProcessStoreBindingProps = typeof BindingProps.Type;

/** A persistent service binding carries its sealed incarnation across WorkerLoader serialization. */
export class HarnessProcessStoreBinding extends WorkerEntrypoint<
  HarnessDurableStateBindings,
  HarnessProcessStoreBindingProps
> {
  execute(command: unknown) {
    const { runId, store, fence } = readBindingProps(this.ctx.props);
    const namespace =
      store === "runStore"
        ? this.env.HARNESS_RUN_STORE
        : store === "filesStore"
          ? this.env.HARNESS_FILES_STORE
          : this.env.HARNESS_THREAD_SUPERVISOR;
    return withRpcStub(namespace.getByName(runId), (stub) =>
      readRpcData(stub.execute(command, fence)),
    );
  }
}
