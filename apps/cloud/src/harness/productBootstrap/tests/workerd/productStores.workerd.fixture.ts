import { HarnessFilesStoreObject as BaseFilesStore } from "../../../HarnessFilesStoreObject.ts";
import { HarnessRunStoreObject } from "../../../HarnessRunStoreObject.ts";

export class ProductFixtureRunStore extends HarnessRunStoreObject {
  readonly #finished = new Map<string, PromiseWithResolvers<void>>();

  async waitForFinish(requestId: string) {
    let waiter = this.#finished.get(requestId);
    if (waiter === undefined) {
      waiter = Promise.withResolvers();
      this.#finished.set(requestId, waiter);
    }
    const current = await super.execute({ type: "read", runId: this.ctx.id.name });
    if (
      current.snapshot.requests?.entries.some(
        (entry) => entry.request.requestId === requestId && entry.status === "completed",
      )
    )
      return;
    await waiter.promise;
  }

  override async execute(command: unknown) {
    const result = await super.execute(command);
    if (
      typeof command === "object" &&
      command !== null &&
      "type" in command &&
      command.type === "request.finish" &&
      "requestId" in command &&
      typeof command.requestId === "string"
    )
      this.#finished.get(command.requestId)?.resolve();
    return result;
  }
}

export class ProductFixtureFilesStore extends BaseFilesStore {
  async injectMaterialFault(checkpointId: string, fault: "missing-files" | "changed-files") {
    const checkpoint = this.ctx.storage.sql
      .exec(
        "SELECT checkpoint_id FROM harness_files_checkpoint WHERE checkpoint_id=?",
        checkpointId,
      )
      .toArray();
    if (checkpoint.length !== 1)
      throw new Error("Fixture checkpoint for fault injection is missing.");
    if (fault === "missing-files") {
      this.ctx.storage.sql.exec(
        "DELETE FROM harness_files_checkpoint WHERE checkpoint_id=?",
        checkpointId,
      );
      return;
    }
    const row = this.ctx.storage.sql
      .exec<{ sha256: string; bytes: ArrayBuffer }>(
        "SELECT sha256,bytes FROM harness_files_blob WHERE sha256 IN (SELECT blob_sha256 FROM harness_files_entry WHERE checkpoint_id=?) LIMIT 1",
        checkpointId,
      )
      .one();
    const bytes = new Uint8Array(row.bytes.slice(0));
    if (bytes.length === 0) throw new Error("Fixture blob for fault injection is empty.");
    const first = bytes[0];
    if (first === undefined) throw new Error("Fixture file bytes are empty.");
    bytes[0] = first ^ 1;
    this.ctx.storage.sql.exec(
      "UPDATE harness_files_blob SET bytes=? WHERE sha256=?",
      bytes.buffer,
      row.sha256,
    );
  }
}
