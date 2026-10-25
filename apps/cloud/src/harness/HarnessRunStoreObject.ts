import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import { createHarnessRunStore, HarnessRunStoreError } from "./HarnessRunStore.ts";

/** Separate from the supervisor DO. Native facets publish here through a private binding. */
export class HarnessRunStoreObject extends DurableObject {
  async execute(command: unknown) {
    const name = this.ctx.id.name;
    if (!name) throw new HarnessRunStoreError("INVALID");
    return Effect.runPromise(createHarnessRunStore(this.ctx.storage, name).execute(command));
  }
}
