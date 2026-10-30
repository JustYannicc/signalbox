import { assert, jsonBytes, reference, sha256, sameArtifact } from "./common.ts";
import type { HarnessRunArtifact } from "../../../../src/harness/HarnessRunStore.ts";

export class BlobJournal {
  readonly storage: DurableObjectStorage;
  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
  }
  async put(id: string, bytes: Uint8Array): Promise<HarnessRunArtifact> {
    const ref = await reference(id, bytes);
    const prior = await this.storage.get<HarnessRunArtifact>(`blob/${id}/ref`);
    if (prior) {
      assert(sameArtifact(prior, ref), `Immutable artifact changed: ${id}`);
      return prior;
    }
    for (let offset = 0; offset < bytes.length; offset += 32768)
      await this.storage.put(
        `blob/${id}/part/${String(offset / 32768).padStart(8, "0")}`,
        bytes.slice(offset, offset + 32768),
      );
    await this.storage.transaction(async (tx) => {
      const old = await tx.get<HarnessRunArtifact>(`blob/${id}/ref`);
      assert(!old || sameArtifact(old, ref), `Concurrent artifact changed: ${id}`);
      await tx.put(`blob/${id}/ref`, ref);
      await tx.put(`export/blob/${id}/ref`, ref);
    });
    return ref;
  }
  async read(ref: HarnessRunArtifact) {
    const recorded = await this.storage.get<HarnessRunArtifact>(`blob/${ref.id}/ref`);
    assert(recorded && sameArtifact(recorded, ref), `Artifact identity changed: ${ref.id}`);
    const bytes = new Uint8Array(ref.bytes);
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      const part = await this.storage.get<Uint8Array>(
        `blob/${ref.id}/part/${String(offset / 32768).padStart(8, "0")}`,
      );
      assert(
        part && part.length === Math.min(32768, bytes.length - offset),
        `Artifact part missing: ${ref.id}/${offset}`,
      );
      bytes.set(part, offset);
    }
    assert((await sha256(bytes)) === ref.sha256, `Artifact hash changed: ${ref.id}`);
    return bytes;
  }
  async append(kind: string, value: unknown) {
    const bytes = jsonBytes(value);
    const payloadHash = await sha256(bytes);
    const sequence = await this.storage.transaction(async (tx) => {
      const next = ((await tx.get<number>("journal/sequence")) ?? 0) + 1;
      await tx.put("journal/sequence", next);
      const reservation = { sequence: next, kind, payloadHash };
      await tx.put(`journal/reservation/${String(next).padStart(10, "0")}`, reservation);
      await tx.put(`export/journal/reservation/${String(next).padStart(10, "0")}`, reservation);
      return next;
    });
    const payload = await this.put(`journal-${sequence}`, bytes);
    const record = { sequence, kind, payload };
    await this.storage.transaction(async (tx) => {
      await tx.put(`journal/record/${String(sequence).padStart(10, "0")}`, record);
      await tx.put(`export/journal/record/${String(sequence).padStart(10, "0")}`, record);
    });
    return { sequence, kind, payload };
  }
  async page(prefix: string, startAfter?: string) {
    const rows = await this.storage.list({
      prefix: `export/${prefix}`,
      ...(startAfter === undefined ? {} : { startAfter: `export/${startAfter}` }),
      limit: 32,
    });
    const entries = [...rows.entries()].map(
      ([key, value]) => [key.slice("export/".length), value] as const,
    );
    return { entries, next: rows.size === 32 ? entries.at(-1)?.[0] : null };
  }
  async audit() {
    const reserved = await this.storage.list({ prefix: "journal/reservation/" });
    const records = await this.storage.list({ prefix: "journal/record/" });
    const sequence = (await this.storage.get<number>("journal/sequence")) ?? 0;
    assert(
      reserved.size === sequence && records.size === sequence,
      "Evidence journal has an unfinished reservation",
    );
    return { sequence, complete: true };
  }
}
