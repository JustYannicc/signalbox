import * as Schema from "effect/Schema";
import { HarnessFilesCheckpoint } from "../HarnessFilesStore.ts";

const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const key = Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(128));
const generation = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const HarnessProcessCheckpointInput = Schema.Struct({
  runId: id,
  processId: id,
  executionOperationId: id,
  processOperationId: id,
  requestId: id,
  nativeSessionId: id,
  control: Schema.Struct({ ownerId: id, incarnationId: id, epoch: generation, controlKey: key }),
  publisher: Schema.Struct({ generation, facetNonce: id, publisherKey: key }),
  checkpoint: HarnessFilesCheckpoint,
});
export type HarnessProcessCheckpointInput = typeof HarnessProcessCheckpointInput.Type;
const decode = Schema.decodeUnknownSync(HarnessProcessCheckpointInput, {
  onExcessProperty: "error",
});

export function snapshotCheckpointInput(supplied: unknown): HarnessProcessCheckpointInput {
  let decoded;
  try {
    decoded = decode(supplied);
  } catch {
    throw new Error("Process checkpoint input is invalid or lacks actual file bytes.");
  }
  return Object.freeze({
    ...decoded,
    control: Object.freeze({ ...decoded.control }),
    publisher: Object.freeze({ ...decoded.publisher }),
    checkpoint: Object.freeze({
      ...decoded.checkpoint,
      files: Object.freeze(
        decoded.checkpoint.files.map((file) =>
          Object.freeze({ ...file, bytes: file.bytes.slice() }),
        ),
      ),
    }),
  });
}

/** Record membership is exact; byte arrays compare their content, never their object identity. */
export function sameData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left instanceof Uint8Array || right instanceof Uint8Array)
    return (
      left instanceof Uint8Array &&
      right instanceof Uint8Array &&
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameData(value, right[index]))
    );
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null)
    return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((name) => Object.hasOwn(b, name) && sameData(a[name], b[name]))
  );
}
