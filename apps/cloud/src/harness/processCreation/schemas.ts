import * as Schema from "effect/Schema";
import { HarnessRunStoreCommand } from "../runStore/schemas.ts";
import { Checkpoint } from "../runStore/requestSchemas.ts";
import { HarnessFilesCheckpoint } from "../HarnessFilesStore.ts";
import {
  id,
  digest,
  HarnessThreadSupervisorControlClaim as Control,
  HarnessThreadSupervisorPublisher as Publisher,
} from "../durableState/shared.ts";
import { NATIVE_SESSION_UUID } from "./identity.ts";

export const CreationIdentity = Schema.Struct({
  shardOwner: id,
  loaderId: id,
  facetKey: id,
  incarnationNonce: id,
});
export const CreationClaim = Schema.Struct({
  runId: id,
  operationId: id,
  processId: id,
  ownerId: id,
  ownerIncarnationId: id,
  controllerClaim: Control,
  descriptorSha256: digest,
});
export const CreationRunInitialization = HarnessRunStoreCommand.members[0];
export const CreationBinding = Schema.Struct({
  nativeSessionId: Schema.String.check(Schema.isPattern(NATIVE_SESSION_UUID)),
  identity: CreationIdentity,
  checkpoint: Checkpoint,
  initialization: Schema.Struct({
    run: CreationRunInitialization,
    nativeSessionId: id,
    control: Control,
    publisher: Publisher,
    checkpoint: HarnessFilesCheckpoint,
  }),
});
export const CreationRecord = Schema.Union([
  Schema.Struct({ phase: Schema.Literal("claimed"), claim: CreationClaim }),
  Schema.Struct({
    phase: Schema.Literals(["staged", "bound"]),
    claim: CreationClaim,
    binding: CreationBinding,
  }),
]);
export const CreationRecoveryInput = Schema.Struct({
  runId: id,
  operationId: id,
  drainOperationId: id,
  control: Control,
  nextControl: Control,
});
