import { HarnessRunStoreObject } from "../../HarnessRunStoreObject.ts";

export class ControlledCreationRunStore extends HarnessRunStoreObject {
  readonly #finished = new Map<string, PromiseWithResolvers<void>>();

  async waitForFinish(requestId: string) {
    let waiter = this.#finished.get(requestId);
    if (waiter === undefined) {
      waiter = Promise.withResolvers<void>();
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
    if (isRequestFinish(command)) this.#finished.get(command.requestId)?.resolve();
    return result;
  }
}

function isRequestFinish(
  value: unknown,
): value is { readonly type: "request.finish"; readonly requestId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "request.finish" &&
    "requestId" in value &&
    typeof value.requestId === "string"
  );
}
