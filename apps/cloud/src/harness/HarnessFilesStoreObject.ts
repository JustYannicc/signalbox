import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import { HarnessFilesStoreError } from "./HarnessFilesStore.ts";
import { createHarnessFilesStore } from "./HarnessFilesStore.ts";
import {
  claimProcessDatabaseFence,
  fencedProcessDatabase,
  readProcessFence,
  sameProcessFence,
} from "./processOwnership/fence.ts";

export class HarnessFilesStoreObject extends DurableObject {
  claimProcessFence(fence: unknown) {
    claimProcessDatabaseFence(this.ctx.storage, fence);
  }

  execute(command: unknown, fence?: unknown) {
    const runId = this.ctx.id.name;
    if (!runId) throw new HarnessFilesStoreError("INVALID");
    if (
      typeof command === "object" &&
      command !== null &&
      "type" in command &&
      command.type === "retireEvictedFacet"
    ) {
      if (
        !("currentFence" in command) ||
        fence === undefined ||
        !sameProcessFence(readProcessFence(command.currentFence), readProcessFence(fence))
      )
        throw new HarnessFilesStoreError("INVALID");
    }
    const checkpointRead =
      typeof command === "object" &&
      command !== null &&
      "type" in command &&
      (command.type === "readCheckpoint" || command.type === "recoverCheckpoint");
    return Effect.runPromise(
      createHarnessFilesStore(
        fencedProcessDatabase(this.ctx.storage, fence, checkpointRead),
        runId,
        // Tokenless checkpoint reads must remain pure, including on a legacy schema.
        { allowCheckpointSchemaMigration: fence !== undefined },
      ).execute(command),
    );
  }
}
