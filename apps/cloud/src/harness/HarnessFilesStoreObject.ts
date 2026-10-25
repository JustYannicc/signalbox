import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import { HarnessFilesStoreError } from "./HarnessFilesStore.ts";
import { createHarnessFilesStore } from "./HarnessFilesStore.ts";

export class HarnessFilesStoreObject extends DurableObject {
  execute(command: unknown) {
    const runId = this.ctx.id.name;
    if (!runId) throw new HarnessFilesStoreError("INVALID");
    return Effect.runPromise(createHarnessFilesStore(this.ctx.storage, runId).execute(command));
  }
}
