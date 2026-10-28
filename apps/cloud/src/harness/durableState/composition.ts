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
  const rawRunStore = bindings.HARNESS_RUN_STORE.getByName(runId);
  const rawFilesStore = bindings.HARNESS_FILES_STORE.getByName(runId);
  const rawSupervisor = bindings.HARNESS_THREAD_SUPERVISOR.getByName(runId);
  const scoped =
    bindings.HARNESS_C_PROCESS_STORES?.forRun(runId) ??
    (fence === undefined
      ? undefined
      : {
          runStore: { execute: (command: unknown) => rawRunStore.execute(command, fence) },
          filesStore: { execute: (command: unknown) => rawFilesStore.execute(command, fence) },
          threadSupervisor: {
            execute: (command: unknown) => rawSupervisor.execute(command, fence),
            reserveReconciliation: (input: unknown) =>
              rawSupervisor.reserveReconciliation(input, fence),
          },
        });
  const runStore = scoped?.runStore ?? rawRunStore;
  const filesStore = scoped?.filesStore ?? rawFilesStore;
  const threadSupervisor = scoped?.threadSupervisor ?? rawSupervisor;
  const stores = { runId, runStore, filesStore, threadSupervisor };

  return {
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
