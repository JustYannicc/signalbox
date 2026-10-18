import * as Schema from "effect/Schema";
import type { DatabaseReader, DatabaseWriter } from "lunorash/server";

import { AuthorizationFence, SyncFailure, SyncReceipt } from "../definition.ts";
import { table } from "../table.ts";

const RECEIPTS = "syncReceipts";
const ReceiptRow = Schema.Struct({
  scope: Schema.String,
  operationKey: Schema.String,
  payload: Schema.String,
  value: Schema.String,
  fences: Schema.Array(AuthorizationFence),
  pending: Schema.Boolean,
});
export const lunoraReceiptTables = {
  [RECEIPTS]: table({
    row: ReceiptRow,
    key: ["scope", "operationKey"],
    indexes: { pending: { fields: ["pending"] } },
  }),
};

const StoredReceipt = Schema.Struct({
  ...ReceiptRow.fields,
  _id: Schema.String,
  _creationTime: Schema.Number,
});
const parseStoredReceipt = Schema.decodeUnknownSync(StoredReceipt);
function decodeStoredReceipt(row: unknown) {
  try {
    return parseStoredReceipt(row);
  } catch {
    throw new SyncFailure({ reason: "storage_corrupt" });
  }
}
async function storage<A>(run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch {
    throw new SyncFailure({ reason: "unavailable" });
  }
}

export type PendingFenceReceipt = {
  readonly receipt: SyncReceipt;
  readonly fences: readonly AuthorizationFence[];
};

export async function findReceipt(db: DatabaseReader, scope: string, operationKey: string) {
  const row = await storage(() =>
    db
      .query(RECEIPTS)
      .withIndex("__sync_key", (q) => q.eq("scope", scope).eq("operationKey", operationKey))
      .unique(),
  );
  return row === null ? null : decodeStoredReceipt(row);
}

export async function saveReceipt(db: DatabaseWriter, row: typeof ReceiptRow.Type) {
  return SyncReceipt.make(await storage(() => db.insert(RECEIPTS, row)));
}

/** Call through an internal query; the returned ids are not public capabilities. */
export type PendingFencePage = {
  readonly receipts: readonly PendingFenceReceipt[];
  readonly after: string | null;
};

export async function pendingFenceReceipts(
  db: DatabaseReader,
  limit = 100,
  after: string | null = null,
): Promise<PendingFencePage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError("Fence recovery limit must be between 1 and 100");
  const page = await storage(() =>
    db
      .query(RECEIPTS)
      .withIndex("pending", (q) => q.eq("pending", true))
      .paginate({ numItems: limit, cursor: after }),
  );
  return {
    receipts: page.page.map((row) => {
      const receipt = decodeStoredReceipt(row);
      return { receipt: SyncReceipt.make(receipt._id), fences: receipt.fences };
    }),
    after: page.isDone ? null : page.continueCursor,
  };
}

/** Only an internal post-install mutation may acknowledge durable fence work. */
export async function acknowledgeFenceReceipt(
  db: DatabaseWriter,
  receipt: SyncReceipt,
): Promise<void> {
  const id = db.asId(RECEIPTS, receipt);
  const row = await storage(() => db.get(id));
  if (row === null) throw new SyncFailure({ reason: "unavailable" });
  const decoded = decodeStoredReceipt(row);
  if (decoded.pending) await storage(() => db.patch(id, { pending: false }));
}
