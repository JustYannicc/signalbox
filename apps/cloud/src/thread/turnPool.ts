import {
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { poolInstanceId } from "@t3tools/contracts/accountHub";

import { poolKindOfInstance } from "./providerCatalog.ts";

/**
 * The pool a thread's turns run on. The owner's object resolves it from the
 * tree (`user/poolChain.ts`) and sends it with each command; the thread takes
 * its own project's. A selection names only a harness: whichever pool its
 * instance id names, the turn runs on the resolved pool's instance of it.
 */

/** Each project's pool, and the top level's for anything else. Null: none on the chain. */
export interface TurnPools {
  readonly top: string | null;
  readonly projects: Readonly<Record<string, string | null>>;
}

export const poolOfProject = (pools: TurnPools, projectId: string): string | null =>
  Object.hasOwn(pools.projects, projectId) ? (pools.projects[projectId] ?? null) : pools.top;

/** `selection` on `poolId`'s instance of the same harness; other providers stay as they are. */
export const onPool = (selection: ModelSelection, poolId: string): ModelSelection => {
  const kind = poolKindOfInstance(selection.instanceId);
  return kind === undefined
    ? selection
    : { ...selection, instanceId: ProviderInstanceId.make(poolInstanceId(kind, poolId)) };
};

/**
 * `command` with its model on `poolId`. A message without a model starts on
 * the thread's, which moves too, so a thread whose pool changed records it.
 */
export const commandOnPool = (
  command: OrchestrationV2Command,
  projection: OrchestrationV2ThreadProjection | null,
  poolId: string,
): OrchestrationV2Command => {
  switch (command.type) {
    case "thread.create":
    case "thread.model-selection.set":
      return { ...command, modelSelection: onPool(command.modelSelection, poolId) };
    case "message.dispatch": {
      const selection = command.modelSelection ?? projection?.thread.modelSelection;
      return selection === undefined
        ? command
        : { ...command, modelSelection: onPool(selection, poolId) };
    }
    default:
      return command;
  }
};
