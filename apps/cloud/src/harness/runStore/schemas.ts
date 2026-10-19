import * as Schema from "effect/Schema";
import { Artifact, capability, id, integer, positive, Progress, Supervisor } from "./values.ts";
import { RequestCommands, RequestMode } from "./requestSchemas.ts";
import { versions } from "./format.ts";
const Seed = Schema.Struct({
  identity: Schema.Struct({
    runId: id,
    hostId: id,
    threadId: id,
    logicalTurnId: id,
    filesystemId: id,
  }),
  locator: Artifact,
  config: Artifact,
  artifacts: Schema.Array(Artifact).check(Schema.isMaxLength(16)),
});
const Claim = Schema.Struct({
  epoch: positive,
  claimId: id,
  requestId: id,
  expectedEpoch: integer,
  supervisorKey: capability,
});
const Declaration = Schema.Struct({
  invocationId: id,
  nativeIncarnationId: id,
  requestId: id,
  locator: Artifact,
});
const Publisher = Schema.Struct({
  invocationId: id,
  nativeIncarnationId: id,
  publisherKey: capability,
});
const Terminal = Schema.Struct({
  sequence: positive,
  status: Schema.Literals(["completed", "failed"]),
  reference: Artifact,
});
const Receipt = Schema.Struct({ receiptId: id, kind: id, subject: Artifact, evidence: Artifact });
const Intent = Schema.Struct({ intentId: id, kind: id, reference: Schema.NullOr(Artifact) });
const Run = { runId: id };
const Controlled = { ...Run, supervisor: Supervisor };

export const HarnessRunStoreCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("initialize"),
    seed: Seed,
    controlKey: capability,
    supervisorKey: capability,
    claimId: id,
    requestId: id,
  }),
  Schema.Struct({ type: Schema.Literal("read"), ...Run }),
  Schema.Struct({
    type: Schema.Literal("takeover"),
    ...Run,
    controlKey: capability,
    supervisorKey: capability,
    expectedEpoch: positive,
    claimId: id,
    requestId: id,
  }),
  Schema.Struct({
    type: Schema.Literal("declare"),
    ...Controlled,
    declaration: Declaration,
    publisherKey: capability,
  }),
  Schema.Struct({
    type: Schema.Literal("progress"),
    ...Run,
    publisher: Publisher,
    progress: Progress,
  }),
  Schema.Struct({
    type: Schema.Literal("complete"),
    ...Run,
    publisher: Publisher,
    terminal: Terminal,
  }),
  Schema.Struct({ type: Schema.Literal("receipt"), ...Controlled, receipt: Receipt }),
  Schema.Struct({ type: Schema.Literal("intent"), ...Controlled, intent: Intent }),
  Schema.Struct({ type: Schema.Literal("retirePublisher"), ...Controlled }),
  RequestCommands,
]);
export type HarnessRunStoreCommand = typeof HarnessRunStoreCommand.Type;

export const State = Schema.Struct({
  version: Schema.Literals(versions),
  seed: Seed,
  controlKey: capability,
  claims: Schema.Array(Claim).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  invocation: Schema.NullOr(
    Schema.Struct({
      declaration: Declaration,
      publisherKey: capability,
      declaredEpoch: positive,
      retired: Schema.Boolean,
    }),
  ),
  progress: Schema.NullOr(Progress),
  terminal: Schema.NullOr(Terminal),
  receipts: Schema.Array(Schema.Struct({ ...Receipt.fields, epoch: positive })).check(
    Schema.isMaxLength(64),
  ),
  intents: Schema.Array(Schema.Struct({ ...Intent.fields, epoch: positive, claimId: id })).check(
    Schema.isMaxLength(64),
  ),
  requests: Schema.optionalKey(RequestMode),
});
export type State = typeof State.Type;
