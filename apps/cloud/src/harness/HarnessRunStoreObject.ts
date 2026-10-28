import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import {
  createHarnessRunStore,
  HarnessRunStoreError,
  readHarnessRunStoreProcessSource,
} from "./HarnessRunStore.ts";
import { claimProcessDatabaseFence, fencedProcessDatabase } from "./processOwnership/fence.ts";

/** Separate from the supervisor DO. Native facets publish here through a private binding. */
export class HarnessRunStoreObject extends DurableObject {
  claimProcessFence(fence: unknown) {
    claimProcessDatabaseFence(this.ctx.storage, fence);
  }

  readProcessSource(input: unknown, fence: unknown) {
    const name = this.ctx.id.name;
    if (!name) throw new HarnessRunStoreError("INVALID");
    return readHarnessRunStoreProcessSource(
      fencedProcessDatabase(this.ctx.storage, fence),
      name,
      input,
    );
  }

  async execute(command: unknown, fence?: unknown) {
    const name = this.ctx.id.name;
    if (!name) throw new HarnessRunStoreError("INVALID");
    return Effect.runPromise(
      createHarnessRunStore(
        fencedProcessDatabase(
          this.ctx.storage,
          fence,
          typeof command === "object" &&
            command !== null &&
            "type" in command &&
            command.type === "read",
        ),
        name,
      ).execute(command),
    );
  }
}
