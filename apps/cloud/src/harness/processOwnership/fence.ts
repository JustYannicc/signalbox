import * as Schema from "effect/Schema";

export const ProcessFence = Schema.Struct({
  owner: Schema.NonEmptyString,
  incarnation: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  nonce: Schema.NonEmptyString,
});
export type ProcessFence = typeof ProcessFence.Type;
export const readProcessFence = Schema.decodeUnknownSync(ProcessFence, {
  onExcessProperty: "error",
});
export const localFenceKey = "harness-process-incarnation/v1/current";
export const fenceHistoryKey = (incarnation: number) =>
  `harness-process-incarnation/v1/history/${incarnation}`;
export const receiverFenceKey = (owner: string) =>
  `harness-process-incarnation/v1/receiver/${encodeURIComponent(owner)}`;

export function sameProcessFence(left: ProcessFence, right: ProcessFence) {
  return (
    left.owner === right.owner &&
    left.incarnation === right.incarnation &&
    left.nonce === right.nonce
  );
}

function assertSuccessor(previous: ProcessFence | undefined, next: ProcessFence) {
  if (
    previous !== undefined &&
    (previous.owner !== next.owner ||
      previous.incarnation > next.incarnation ||
      (previous.incarnation === next.incarnation && !sameProcessFence(previous, next)))
  )
    throw new Error("A stale process-shard incarnation cannot claim this store.");
}

export async function claimProcessFence(storage: DurableObjectStorage, supplied: unknown) {
  const fence = readProcessFence(supplied);
  await storage.transaction(async (transaction) => {
    const key = receiverFenceKey(fence.owner);
    const previous = await transaction.get<ProcessFence>(key);
    assertSuccessor(previous === undefined ? undefined : readProcessFence(previous), fence);
    await transaction.put(key, fence);
  });
}

export async function assertProcessFenceNonce(
  transaction: DurableObjectTransaction,
  owner: string,
  nonce: string,
) {
  const fence = await transaction.get<ProcessFence>(receiverFenceKey(owner));
  if (fence !== undefined && readProcessFence(fence).nonce !== nonce)
    throw new Error("A stale process-shard incarnation cannot mutate placement.");
}

interface FenceDatabase {
  readonly sql: {
    exec(query: string, ...bindings: (string | number | null)[]): Iterable<Record<string, unknown>>;
  };
  transactionSync<A>(operation: () => A): A;
}
const fenceTable = "harness_process_incarnation_fence";

function readReceiverFence(database: FenceDatabase, owner: string) {
  const rows = database.sql.exec(
    `SELECT owner, incarnation, nonce FROM ${fenceTable} WHERE owner = ?`,
    owner,
  );
  const row = rows[Symbol.iterator]().next().value;
  return row === undefined ? undefined : readProcessFence(row);
}

export function claimProcessDatabaseFence(database: FenceDatabase, supplied: unknown) {
  const fence = readProcessFence(supplied);
  database.transactionSync(() => {
    database.sql.exec(`CREATE TABLE IF NOT EXISTS ${fenceTable} (
      owner TEXT PRIMARY KEY, incarnation INTEGER NOT NULL, nonce TEXT NOT NULL
    )`);
    assertSuccessor(readReceiverFence(database, fence.owner), fence);
    database.sql.exec(
      `INSERT INTO ${fenceTable} (owner, incarnation, nonce) VALUES (?, ?, ?)
       ON CONFLICT(owner) DO UPDATE SET incarnation=excluded.incarnation, nonce=excluded.nonce`,
      fence.owner,
      fence.incarnation,
      fence.nonce,
    );
  });
}

/** Check in the receiver's write transaction, including writes resumed after asynchronous hashing. */
export function fencedProcessDatabase<Database extends FenceDatabase>(
  database: Database,
  supplied: unknown,
  readOnly = false,
) {
  if (supplied === undefined && readOnly) return database;
  const fence = supplied === undefined ? undefined : readProcessFence(supplied);
  return {
    sql: database.sql,
    transactionSync<A>(operation: () => A) {
      return database.transactionSync(() => {
        if (fence === undefined) {
          const tables = database.sql.exec(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            fenceTable,
          );
          const table = tables[Symbol.iterator]().next().value;
          if (
            table !== undefined &&
            database.sql.exec(`SELECT owner FROM ${fenceTable} LIMIT 1`)[Symbol.iterator]().next()
              .value !== undefined
          )
            throw new Error(
              "A process incarnation fence is required for this write or publication.",
            );
        } else {
          const current = readReceiverFence(database, fence.owner);
          if (current === undefined || !sameProcessFence(current, fence))
            throw new Error("A stale process-shard incarnation cannot write or publish.");
        }
        return operation();
      });
    },
  };
}
