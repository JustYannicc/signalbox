import * as Schema from "effect/Schema";
import type { ForkCommit } from "../../src/kernel/FilePersistencePorts.ts";

export interface ProofRecoveryReceipt {
  readonly before: ForkCommit;
  readonly after: ForkCommit;
  readonly inode: bigint;
  readonly sourceRef: string;
  readonly operationId: string;
}

const revision = Schema.Struct({
  repository: Schema.String,
  fork: Schema.String,
  commit: Schema.String,
});
const cut = Schema.fromJsonString(
  Schema.Struct({
    constructorId: Schema.String,
    before: revision,
    after: revision,
    inode: Schema.BigIntFromString,
    sourceRef: Schema.String,
    operationId: Schema.String,
  }),
);
const encode = Schema.encodeSync(cut);
const decode = Schema.decodeUnknownSync(cut);
export const PROOF_REPLACEMENT_CUT = "proof-owner-replacement-cut";

/** The persisted cut survives aborting the object; it carries no reconnect handles. */
export function encodeProofReplacementCut(constructorId: string, receipt: ProofRecoveryReceipt) {
  if (
    !constructorId ||
    !receipt.sourceRef ||
    !receipt.operationId ||
    receipt.inode <= 0n ||
    receipt.before.repository !== receipt.after.repository ||
    receipt.before.fork !== receipt.after.fork ||
    receipt.before.commit === receipt.after.commit
  ) {
    throw new Error("Invalid durable proof recovery cut");
  }
  return encode({ constructorId, ...receipt });
}

export function decodeProofReplacementCut(value: unknown) {
  const decoded = decode(value);
  encodeProofReplacementCut(decoded.constructorId, decoded);
  return Object.freeze({
    ...decoded,
    before: Object.freeze(decoded.before),
    after: Object.freeze(decoded.after),
  });
}
