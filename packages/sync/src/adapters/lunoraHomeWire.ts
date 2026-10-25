import * as Schema from "effect/Schema";
import { LunoraError } from "lunorash/errors";

import { SyncFailure, SyncReceipt, type Commit, type SyncSchema } from "../definition.ts";
import { encodeWireValue, wireValueSchema, type WireValue } from "./lunoraWireValue.ts";

export type WireCommit<Output extends SyncSchema> = Commit<WireValue<Output>>;
const isSyncFailure = Schema.is(SyncFailure);

export function commitOutput<Output extends SyncSchema>(
  output: Output,
): Schema.Schema<WireCommit<Output>> {
  const value = wireValueSchema(output);
  return Schema.Union([
    Schema.TaggedStruct("Committed", { value, receipt: SyncReceipt }),
    Schema.TaggedStruct("Pending", { operationKey: Schema.String }),
  ]);
}

/** Throwing the native error preserves rollback and carries the declared failure over native RPC. */
export async function writeWire<Output extends SyncSchema, Failure extends SyncSchema>(
  output: Output,
  failure: Failure,
  run: () => Promise<Commit<Output["Type"]>>,
  verify: () => Promise<() => void>,
): Promise<WireCommit<Output>> {
  try {
    const commit = await run();
    // The write checked admission or replay authority; Pending exposes no protected output.
    if (commit._tag === "Pending") return commit;
    const result = {
      ...commit,
      value: await encodeWireValue(output, commit.value, "unavailable"),
    };
    const current = await verify();
    current();
    return result;
  } catch (error) {
    let syncFailure: SyncFailure;
    if (isSyncFailure(error)) syncFailure = error;
    else {
      let encoded: WireValue<Failure>;
      try {
        encoded = await encodeWireValue(failure, error, "unavailable");
        const current = await verify();
        current();
      } catch (verification) {
        throw syncError(
          isSyncFailure(verification) ? verification : new SyncFailure({ reason: "unavailable" }),
        );
      }
      throw new LunoraError("SYNC_DOMAIN_FAILURE", "Sync operation failed", {
        status: 422,
        data: { _tag: "SyncDomainFailure", failure: encoded },
      });
    }
    throw syncError(syncFailure);
  }
}

export function asLunoraSyncError(error: unknown) {
  return syncError(isSyncFailure(error) ? error : new SyncFailure({ reason: "unavailable" }));
}

function syncError(failure: SyncFailure) {
  const code =
    failure.reason === "denied"
      ? "FORBIDDEN"
      : failure.reason === "invalid_cursor"
        ? "INVALID_CURSOR"
        : "SYNC_FAILURE";
  return new LunoraError(code, "Sync operation failed", {
    status: failure.reason === "denied" ? 403 : 422,
    data: { _tag: "SyncFailure", reason: failure.reason },
  });
}
