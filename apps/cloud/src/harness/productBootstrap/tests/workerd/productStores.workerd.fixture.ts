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
