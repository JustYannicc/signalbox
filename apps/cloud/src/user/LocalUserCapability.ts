import type { OrchestrationV2DispatchCommandResult } from "@t3tools/contracts";
import type { AccountProfile } from "@t3tools/contracts/account";
import type { SignalboxContext, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import type { SignalboxDrive, SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";
import type { CommitAuthor } from "@signalbox/runner-protocol/DriveProtocol";
import { RpcTarget } from "cloudflare:workers";

import type { Actor } from "../thread/ThreadAccess.ts";

/** The user-domain operations the thread object may rely on. */
export type LocalUserCapabilityMethods = {
  readonly getActor: () => Promise<Actor>;
  readonly profile: () => Promise<AccountProfile | null>;
  readonly githubCommitAuthor: () => Promise<CommitAuthor | null>;
  readonly onePasswordToken: () => Promise<string | null>;
  readonly contextIds: () => Promise<ReadonlyArray<SignalboxContextId>>;
  readonly driveAccess: (driveId: string) => Promise<SignalboxDriveRole | null>;
  readonly readableDrives: () => Promise<{
    readonly contexts: ReadonlyArray<SignalboxContext>;
    readonly drives: ReadonlyArray<SignalboxDrive>;
  }>;
  readonly dispatchContinuation: (
    actor: Actor,
    command: unknown,
  ) => Promise<OrchestrationV2DispatchCommandResult>;
  readonly recordThreadSummary: (summary: unknown) => Promise<void>;
};

/** The public client type avoids concrete RpcTarget private-field nominality. */
export interface LocalUserCapabilityApi extends RpcTarget, LocalUserCapabilityMethods {}

/** Retains the real user's domain methods behind one callable RPC capability. */
export class LocalUserCapability extends RpcTarget implements LocalUserCapabilityApi {
  readonly #api: LocalUserCapabilityMethods;

  constructor(api: LocalUserCapabilityMethods) {
    super();
    this.#api = api;
  }

  getActor(...args: Parameters<LocalUserCapabilityMethods["getActor"]>) {
    return this.#api.getActor(...args);
  }
  profile(...args: Parameters<LocalUserCapabilityMethods["profile"]>) {
    return this.#api.profile(...args);
  }
  githubCommitAuthor(...args: Parameters<LocalUserCapabilityMethods["githubCommitAuthor"]>) {
    return this.#api.githubCommitAuthor(...args);
  }
  onePasswordToken(...args: Parameters<LocalUserCapabilityMethods["onePasswordToken"]>) {
    return this.#api.onePasswordToken(...args);
  }
  contextIds(...args: Parameters<LocalUserCapabilityMethods["contextIds"]>) {
    return this.#api.contextIds(...args);
  }
  driveAccess(...args: Parameters<LocalUserCapabilityMethods["driveAccess"]>) {
    return this.#api.driveAccess(...args);
  }
  readableDrives(...args: Parameters<LocalUserCapabilityMethods["readableDrives"]>) {
    return this.#api.readableDrives(...args);
  }
  dispatchContinuation(...args: Parameters<LocalUserCapabilityMethods["dispatchContinuation"]>) {
    return this.#api.dispatchContinuation(...args);
  }
  recordThreadSummary(...args: Parameters<LocalUserCapabilityMethods["recordThreadSummary"]>) {
    return this.#api.recordThreadSummary(...args);
  }
}
