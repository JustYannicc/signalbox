import { readRpcData, withRpcStub } from "../../rpc/Resources.ts";
import type {
  HarnessDurableState,
  HarnessDurableStateBindings,
  HarnessFilesPrivateCommand,
  HarnessSupervisorPrivateCommand,
} from "./types.ts";
import {
  admitStep,
  beginDrain,
  commitCheckpoint,
  initialize,
  recordActivation,
  recordActivationFailure,
  recordPreparedFacetFailure,
} from "./operations.ts";
import { publishFreshFacet } from "./publication.ts";
import { reconcile } from "./reconciliation.ts";
import { HarnessDurableStateError } from "./errors.ts";
import type { ProcessFence } from "../processOwnership/fence.ts";

const privateSupervisorCommands = new Set([
  "read",
  "recordStopAcknowledgement",
  "settleInvocation",
  "prepareFreshFacet",
]);

export function createHarnessDurableState(
  bindings: HarnessDurableStateBindings,
  runId: string,
  fence?: ProcessFence,
): HarnessDurableState {
  if (!runId) throw new HarnessDurableStateError({ code: "INVALID" });
  const scoped = bindings.HARNESS_C_PROCESS_STORES?.forRun(runId);
  const runStore = {
    execute: (command: unknown) =>
      scoped
        ? readRpcData(scoped.runStore.execute(command))
        : withRpcStub(bindings.HARNESS_RUN_STORE.getByName(runId), (stub) =>
            readRpcData(stub.execute(command, fence)),
          ),
  };
  const filesStore = {
    execute: (command: unknown) =>
      scoped
        ? readRpcData(scoped.filesStore.execute(command))
        : withRpcStub(bindings.HARNESS_FILES_STORE.getByName(runId), (stub) =>
            readRpcData(stub.execute(command, fence)),
          ),
  };
  const threadSupervisor = {
    execute: (command: unknown) =>
      scoped
        ? readRpcData(scoped.threadSupervisor.execute(command))
        : withRpcStub(bindings.HARNESS_THREAD_SUPERVISOR.getByName(runId), (stub) =>
            readRpcData(stub.execute(command, fence)),
          ),
    reserveReconciliation: (
      input: Parameters<NonNullable<typeof scoped>["threadSupervisor"]["reserveReconciliation"]>[0],
    ) =>
      scoped
        ? readRpcData(scoped.threadSupervisor.reserveReconciliation(input))
        : withRpcStub(bindings.HARNESS_THREAD_SUPERVISOR.getByName(runId), (stub) =>
            readRpcData(stub.reserveReconciliation(input, fence)),
          ),
  };
  const stores = { runId, runStore, filesStore, threadSupervisor };

  return {
    retireEvictedFacet: async (input) => {
      const command = { ...input, type: "retireEvictedFacet" as const, runId };
      const supervisor = await threadSupervisor.execute(command);
      const files = await filesStore.execute(command);
      return { supervisor, files };
    },
    runStore,
    filesStore: {
      execute: async (command: HarnessFilesPrivateCommand) => {
        if (command.type !== "readCheckpoint" && command.type !== "recoverCheckpoint")
          throw new HarnessDurableStateError({ code: "INVALID" });
        return filesStore.execute(command);
      },
    },
    threadSupervisor: {
      execute: async (command: HarnessSupervisorPrivateCommand) => {
        if (
          typeof command !== "object" ||
          command === null ||
          !privateSupervisorCommands.has(command.type)
        )
          throw new HarnessDurableStateError({ code: "INVALID" });
        return threadSupervisor.execute(command);
      },
    },
    initialize: (input) => initialize(stores, input),
    beginDrain: (input) => beginDrain(stores, input),
    admitStep: (input) => admitStep(stores, input),
    commitCheckpoint: (input) => commitCheckpoint(stores, input),
    publishFreshFacet: (input) => publishFreshFacet(stores, input),
    recordActivation: (input) => recordActivation(stores, input),
    recordActivationFailure: (input) => recordActivationFailure(stores, input),
    recordPreparedFacetFailure: (input) => recordPreparedFacetFailure(stores, input),
    reconcile: (input) => reconcile(stores, input),
    readPublication: async ({ control, operationId }) => {
      await threadSupervisor.execute({ type: "read", runId, control });
      return filesStore.execute({ type: "readPublication", runId, control, operationId });
    },
  };
}
