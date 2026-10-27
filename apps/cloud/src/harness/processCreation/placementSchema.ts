import { sameControl } from "../processResume/authority.ts";
import * as Schema from "effect/Schema";
import type { ProcessSlotLeaseToken } from "../../computer/ProcessSlots.ts";
import {
  capability,
  id,
  digest,
  positive,
  HarnessThreadSupervisorControlClaim as Control,
} from "../durableState/shared.ts";
import { snapshotHarnessProcessModules } from "../processPlacement/moduleCode.ts";
import { snapshotPreparedRelease } from "../processResume/identity.ts";
import { CreationIdentity, CreationRunInitialization } from "./schemas.ts";
import type { HarnessProcessCreationInput, HarnessProcessCreationPlacement } from "./contracts.ts";

const natural = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const moduleType = Schema.Literals(["js", "cjs", "text", "wasm"]);
const file = { bytes: natural, sha256: digest };
const release = Schema.Struct({
  artifact: Schema.Struct({
    provider: Schema.Literals(["codex", "claude-code", "agent-sdk"]),
    releaseId: id,
    artifactHash: digest,
    artifactRef: id,
    sourceIdentity: id,
    fixtureIdentity: id,
    createdAt: id,
  }),
  plan: Schema.Struct({
    release: Schema.Struct({
      harness: Schema.Literals(["codex", "claude-code"]),
      version: id,
      manifestSha256: digest,
      modules: Schema.Record(Schema.String, Schema.Struct(file)),
    }),
    sourceIdentity: id,
    computer: Schema.Struct({ sourceIdentity: id, manifestSha256: digest }),
    preparedModules: Schema.Record(
      Schema.String,
      Schema.Struct({
        ...file,
        component: Schema.Literals(["codex", "cli", "sdk"]),
        name: id,
        path: id,
        type: moduleType,
      }),
    ),
  }),
});
const CreationInput = Schema.Struct({
  runId: id,
  operationId: id,
  run: CreationRunInitialization,
  controllerClaim: Control,
  publisherKey: capability,
  requestPublisherKey: capability,
  requestModeId: id,
  facet: Schema.Struct({
    processId: id,
    codeId: id,
    residentBytes: positive,
    mainModule: id,
    modules: Schema.Unknown,
    entrypoint: id,
    facetEnv: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    productBootstrap: Schema.Struct({
      provider: Schema.Literals(["codex", "claude-code"]),
      preparedReleaseId: id,
      restoreMode: Schema.Literals([
        "same-variant-serialized-checkpoint",
        "cross-variant-fresh-boot",
      ]),
    }),
    targetPreparedRelease: release,
  }),
});
const decodeInput = Schema.decodeUnknownSync(CreationInput, { onExcessProperty: "error" });
export function readCreationInput(value: unknown): HarnessProcessCreationInput {
  const input = decodeInput(value);
  const modules = snapshotHarnessProcessModules(input.facet.modules, input.facet.mainModule);
  const targetPreparedRelease = snapshotPreparedRelease(input.facet.targetPreparedRelease);
  if (!modules || !targetPreparedRelease)
    throw new Error("Cold creation code or prepared release is corrupt.");
  return { ...input, facet: { ...input.facet, modules, targetPreparedRelease } };
}

const leaseToken = Schema.declare<ProcessSlotLeaseToken>(
  (value): value is ProcessSlotLeaseToken =>
    typeof value === "string" && value.length > 0 && value.length <= 256,
);
const Writer = Schema.Struct({
  executionOperationId: id,
  shardIndex: natural,
  shardIncarnationNonce: id,
  controllerClaim: Control,
});
const Placement = Schema.Struct({
  version: Schema.Literal(1),
  operationId: id,
  owner: id,
  writer: Writer,
  releaseWriter: Schema.optionalKey(Writer),
  lease: Schema.Struct({ token: leaseToken, loaderId: id, codeId: id, residentBytes: positive }),
  input: Schema.Unknown,
  identity: Schema.optionalKey(CreationIdentity),
  disposed: Schema.optionalKey(Schema.Literal(true)),
  released: Schema.optionalKey(Schema.Literal(true)),
  termination: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("disposed"), facetNonce: id }),
      Schema.Struct({ kind: Schema.Literal("parent-destroyed"), observedByIncarnationNonce: id }),
    ]),
  ),
});
const decodePlacement = Schema.decodeUnknownSync(Placement, { onExcessProperty: "error" });
export function readCreationPlacement(value: unknown): HarnessProcessCreationPlacement {
  try {
    const record = decodePlacement(value);
    const input = readCreationInput(record.input);
    if (
      record.operationId !== input.operationId ||
      record.writer.executionOperationId !== input.operationId ||
      record.writer.shardIndex !== 0 ||
      !sameControl(record.writer.controllerClaim, input.controllerClaim) ||
      record.lease.residentBytes !== input.facet.residentBytes ||
      (record.identity !== undefined &&
        (record.identity.shardOwner !== record.owner ||
          record.identity.loaderId !== record.lease.loaderId ||
          record.identity.facetKey !== record.lease.loaderId))
    )
      throw new Error("The creation placement identities disagree.");
    if (
      record.termination?.kind === "disposed" &&
      (record.disposed !== true ||
        record.termination.facetNonce !== record.identity?.incarnationNonce)
    )
      throw new Error("The creation stop receipt does not identify its facet.");
    if (
      record.termination?.kind === "parent-destroyed" &&
      (record.disposed === true ||
        record.termination.observedByIncarnationNonce === record.writer.shardIncarnationNonce)
    )
      throw new Error("The creation destruction record does not identify a new parent.");
    if (
      record.releaseWriter &&
      (!record.termination ||
        record.releaseWriter.executionOperationId !== record.operationId ||
        record.releaseWriter.shardIndex !== 0 ||
        !sameControl(record.releaseWriter.controllerClaim, record.writer.controllerClaim))
    )
      throw new Error("The creation writer release belongs to another operation.");
    if (record.released && !record.termination)
      throw new Error("The creation lease was released without a termination disposition.");
    return { ...record, input };
  } catch (cause) {
    throw new Error("Harness process creation placement is corrupt.", { cause });
  }
}
