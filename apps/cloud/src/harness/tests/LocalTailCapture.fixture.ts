export interface TailRecord {
  readonly key: string;
  readonly raw: string;
  readonly sha256: string;
  readonly ingress: "outer-platform";
}
export interface TailTerminal {
  readonly key: string;
  readonly sha256: string;
  readonly runId: string;
  readonly invocationId: string;
}
interface TailTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<unknown>;
}
export interface TailStorage extends TailTransaction {
  transaction<T>(body: (tx: TailTransaction) => Promise<T>): Promise<T>;
  list<T>(options: {
    prefix: string;
    startAfter?: string;
    end?: string;
    limit?: number;
  }): Promise<Map<string, T>>;
}
export interface TailDrain {
  readonly after: number;
  readonly nextCursor: number;
  readonly records: readonly TailRecord[];
  readonly expectedInvocations: readonly string[];
  readonly terminalEvidence: readonly TailTerminal[];
}
const encoder = new TextEncoder();
export async function tailDigest(raw: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(raw)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export const tailKey = (sequence: number) => `raw/${String(sequence).padStart(10, "0")}`;
const terminalKey = (id: string) => `terminal/${encodeURIComponent(id)}`;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function terminalEvents(raw: string, runId: string) {
  const events: { invocationId: string; runId: string }[] = [];
  const items: unknown = JSON.parse(raw);
  if (!Array.isArray(items)) throw new Error("Actual Tail batch is not an array");
  for (const item of items) {
    if (!object(item)) throw new Error("Actual Tail item is not an object");
    for (const log of Array.isArray(item.logs) ? item.logs : []) {
      if (!object(log)) continue;
      for (const arg of Array.isArray(log.message) ? log.message : [log.message]) {
        if (typeof arg !== "string") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(arg);
        } catch {
          continue;
        }
        if (!object(parsed) || !object(parsed.producerEvent)) continue;
        const event = parsed.producerEvent;
        if (
          event.schema === "sb1070/producer/v1" &&
          event.runId === runId &&
          event.milestone === "terminal" &&
          typeof event.invocationId === "string"
        )
          events.push({ invocationId: event.invocationId, runId });
      }
    }
  }
  return events;
}

/** The cursor names durable raw records, independent of which invocation wakes a drain. */
export class LocalTailCapture {
  private readonly waiters = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<TailTerminal>>
  >();
  private readonly storage: TailStorage;
  private readonly runId: string;
  constructor(storage: TailStorage, runId: string) {
    this.storage = storage;
    this.runId = runId;
  }

  async append(items: unknown[]) {
    if (!Array.isArray(items) || !items.length) throw new Error("Empty actual Tail batch");
    const raw = JSON.stringify(items);
    if (encoder.encode(raw).length > 96 * 1024)
      throw new Error("Actual local tail batch exceeded complete capture bound");
    const events = terminalEvents(raw, this.runId);
    const sha256 = await tailDigest(raw);
    const evidence = await this.storage.transaction(async (tx) => {
      const sequence = ((await tx.get<number>("sequence")) ?? 0) + 1;
      const key = tailKey(sequence);
      await tx.put("sequence", sequence);
      await tx.put(key, raw);
      const entries = events.map((event) => ({
        key,
        sha256,
        runId: event.runId,
        invocationId: event.invocationId,
      }));
      for (const entry of entries) await tx.put(terminalKey(entry.invocationId), entry);
      return entries;
    });
    for (const entry of evidence) this.waiters.get(entry.invocationId)?.resolve(entry);
  }

  private async validate(entry: TailTerminal, id: string) {
    if (entry.runId !== this.runId || entry.invocationId !== id || !/^raw\/\d{10}$/.test(entry.key))
      throw new Error("Tail terminal index identity mismatch");
    const raw = await this.storage.get<string>(entry.key);
    if (
      typeof raw !== "string" ||
      (await tailDigest(raw)) !== entry.sha256 ||
      !terminalEvents(raw, this.runId).some((event) => event.invocationId === id)
    )
      throw new Error("Tail terminal index does not match exact raw record");
    return entry;
  }

  async drain({ after, ids }: { after: number; ids: readonly string[] }): Promise<TailDrain> {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Array.isArray(ids) ||
      ids.some((id) => typeof id !== "string" || !id) ||
      new Set(ids).size !== ids.length
    )
      throw new Error("Invalid Tail cursor or invocation identities");
    if (after > ((await this.storage.get<number>("sequence")) ?? 0))
      throw new Error("Tail cursor is ahead of durable records");
    const evidence: TailTerminal[] = [];
    for (const id of ids) {
      let waiter = this.waiters.get(id);
      if (!waiter) {
        waiter = Promise.withResolvers<TailTerminal>();
        this.waiters.set(id, waiter);
      }
      try {
        // Register before lookup so an append cannot lose its wake.
        const indexed = await this.storage.get<TailTerminal>(terminalKey(id));
        evidence.push(await this.validate(indexed ?? (await waiter.promise), id));
      } finally {
        if (this.waiters.get(id) === waiter) this.waiters.delete(id);
      }
    }
    const nextCursor = (await this.storage.get<number>("sequence")) ?? 0;
    const records: TailRecord[] = [];
    let cursor = after;
    while (cursor < nextCursor) {
      const rows = await this.storage.list<string>({
        prefix: "raw/",
        startAfter: tailKey(cursor),
        end: tailKey(nextCursor + 1),
        limit: 1000,
      });
      if (!rows.size) throw new Error("Tail raw sequence is incomplete");
      for (const [key, raw] of rows) {
        if (key !== tailKey(cursor + 1) || cursor >= nextCursor || typeof raw !== "string")
          throw new Error("Tail raw sequence has a gap");
        records.push({ key, raw, sha256: await tailDigest(raw), ingress: "outer-platform" });
        cursor++;
      }
    }
    return {
      after,
      nextCursor,
      records,
      expectedInvocations: [...ids],
      terminalEvidence: evidence,
    };
  }
}
