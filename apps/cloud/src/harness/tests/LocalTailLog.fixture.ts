import {
  tailDigest,
  tailKey,
  type TailDrain,
  type TailRecord,
  type TailTerminal,
} from "./LocalTailCapture.fixture.ts";

export interface TailLogFile {
  writeFile(text: string): Promise<unknown>;
  sync(): Promise<unknown>;
  readFile(): Promise<string>;
  close(): Promise<unknown>;
}

/** A successful append is durable before its cursor can be sent back to the relay. */
export async function createLocalTailLog(handle: TailLogFile, runId: string) {
  let cursor = 0;
  let failed = false;
  let appending = false;
  const terminals = new Set<string>();
  const rawProofs = new Map<string, string>();
  const validateTerminal = (
    entry: TailTerminal,
    id: string,
    proofs: ReadonlyMap<string, string>,
  ) => {
    if (
      entry.invocationId !== id ||
      entry.runId !== runId ||
      (proofs.get(entry.key) ?? rawProofs.get(entry.key)) !== entry.sha256
    )
      throw new Error("Tail terminal does not bind a captured raw record");
  };
  return {
    get cursor() {
      return cursor;
    },
    async append(batch: TailDrain, expectedInvocations: readonly string[]) {
      if (failed) throw new Error("Tail log cannot continue after a failed write");
      if (appending) throw new Error("Concurrent Tail log append is forbidden");
      appending = true;
      try {
        if (
          batch.after !== cursor ||
          !Number.isSafeInteger(batch.nextCursor) ||
          batch.nextCursor < cursor ||
          batch.records.length !== batch.nextCursor - cursor ||
          JSON.stringify(batch.expectedInvocations) !== JSON.stringify(expectedInvocations) ||
          batch.terminalEvidence.length !== expectedInvocations.length
        )
          throw new Error("Tail drain cursor or invocation mismatch");
        const newProofs = new Map<string, string>();
        for (const [index, record] of batch.records.entries()) {
          if (
            record.key !== tailKey(cursor + index + 1) ||
            record.ingress !== "outer-platform" ||
            (await tailDigest(record.raw)) !== record.sha256
          )
            throw new Error("Tail drain raw record mismatch");
          newProofs.set(record.key, record.sha256);
        }
        for (const [index, id] of expectedInvocations.entries()) {
          const entry = batch.terminalEvidence[index];
          if (!entry) throw new Error("Missing Tail terminal evidence");
          validateTerminal(entry, id, newProofs);
        }
        try {
          // Separate receipts never contain another copy of raw history.
          for (const record of batch.records) await handle.writeFile(JSON.stringify(record) + "\n");
          await handle.sync();
        } catch (cause) {
          failed = true;
          throw cause;
        }
        cursor = batch.nextCursor;
        for (const record of batch.records) rawProofs.set(record.key, record.sha256);
        for (const id of expectedInvocations) terminals.add(id);
        const { records: _records, ...receipt } = batch;
        return { ...receipt, capturedRecords: batch.records.length };
      } finally {
        appending = false;
      }
    },
    async snapshot() {
      if (appending || failed)
        throw new Error("Tail log snapshot is unavailable during or after a failed write");
      const text = await handle.readFile();
      const records: TailRecord[] = text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (
        records.length !== cursor ||
        records.some((record, index) => record.key !== tailKey(index + 1))
      )
        throw new Error("Persisted Tail log sequence mismatch");
      for (const record of records)
        if (
          record.ingress !== "outer-platform" ||
          record.sha256 !== rawProofs.get(record.key) ||
          (await tailDigest(record.raw)) !== record.sha256
        )
          throw new Error("Persisted Tail bytes changed");
      return { records, terminals: [...terminals] };
    },
    async close() {
      await handle.close();
    },
  };
}
