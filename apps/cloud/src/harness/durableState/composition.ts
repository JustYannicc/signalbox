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

const privateSupervisorCommands = new Set([
  "read",
  "recordStopAcknowledgement",
  "settleInvocation",
  "prepareFreshFacet",
]);

export function createHarnessDurableState(
  bindings: HarnessDurableStateBindings,
  runId: string,
): HarnessDurableState {
  if (!runId) throw new HarnessDurableStateError({ code: "INVALID" });
  const runStore = bindings.HARNESS_RUN_STORE.getByName(runId);
  const filesStore = bindings.HARNESS_FILES_STORE.getByName(runId);
  const threadSupervisor = bindings.HARNESS_THREAD_SUPERVISOR.getByName(runId);
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
