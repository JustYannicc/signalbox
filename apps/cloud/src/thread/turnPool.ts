import {
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { poolInstanceId } from "@t3tools/contracts/accountHub";
import type {
  OnePasswordEnvironmentId,
  SecretEnvironmentName,
} from "@t3tools/contracts/signalboxFolders";
import type { FolderInstructions } from "@signalbox/runner-protocol/DriveProtocol";

import { poolKindOfInstance } from "../models/ModelRouting.ts";

/**
 * What a thread's turns run on and follow: its pool, its chain's `AGENTS.md`
 * and its chain's secrets. The owner's object resolves them from the tree
 * (`user/folderTree.ts`) and sends them with each command: for the thread's
 * own home when it knows the thread, and for each project's home, so the
 * thread object can pick by the project it knows. A selection names only a
 * harness: whichever pool its instance id names, the turn runs on the
 * resolved pool's instance of it.
 */

/** One value per home a thread can have. */
export interface ByHome<A> {
  readonly top: A;
  /** Each project's home's: where its threads live unless filed elsewhere. */
  readonly projects: Readonly<Record<string, A>>;
  /** The thread's own home's, when the owner's object knows the thread. */
  readonly thread?: A;
}

/** Null: no pool on the chain. */
export type TurnPools = ByHome<string | null>;
/** Top level first. */
export type TurnInstructions = ByHome<ReadonlyArray<FolderInstructions>>;
/** One name filter per Environment, in the same order. Null gives the home its full Environment. */
export type SecretEnvironmentNames = ReadonlyArray<ReadonlyArray<SecretEnvironmentName> | null>;
/** The 1Password Environments and their subfolder access rules, per home (#395, #695). */
export interface TurnSecrets extends ByHome<ReadonlyArray<OnePasswordEnvironmentId>> {
  /** Mirrors the home keys; omitted by callers predating #695. */
  readonly environmentNames?: ByHome<SecretEnvironmentNames>;
}

/** The value for a thread in `projectId`. */
export const forThread = <A>(byHome: ByHome<A>, projectId: string): A =>
  byHome.thread !== undefined
    ? byHome.thread
    : Object.hasOwn(byHome.projects, projectId)
      ? (byHome.projects[projectId] as A)
      : byHome.top;

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
