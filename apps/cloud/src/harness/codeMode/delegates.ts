import { fail, type Json, type WireResult } from "./types.ts";

type DelegateResponse = { type: "tool/result"; result: Json } | { type: "notification/delivered" };
type Pending = {
  readonly cell: object;
  readonly complete: (result: WireResult<DelegateResponse>) => void;
};

export class CodeModeDelegates {
  readonly #send: (message: unknown) => void;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;

  constructor(send: (message: unknown) => void) {
    this.#send = send;
  }

  async request(
    cell: object,
    sessionId: string,
    request: unknown,
    expected: DelegateResponse["type"],
  ): Promise<Json> {
    if (this.#pending.size >= 1024) throw new Error("Too many unresolved CodeMode delegate calls");
    const id = this.#nextId++;
    const result = Promise.withResolvers<WireResult<DelegateResponse>>();
    this.#pending.set(id, { cell, complete: result.resolve });
    this.#send({ type: "delegate/request", id, sessionId, request });
    const response = await result.promise;
    if (response.status === "error") throw new Error(response.message);
    if (response.value.type !== expected)
      throw new Error("CodeMode client returned an invalid delegate result");
    return response.value.type === "tool/result" ? response.value.result : null;
  }

  complete(id: number, result: WireResult<DelegateResponse>) {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    pending.complete(result);
  }

  cancel(cell: object) {
    for (const [id, pending] of this.#pending) {
      if (pending.cell !== cell) continue;
      this.#pending.delete(id);
      this.#send({ type: "delegate/cancel", id });
      pending.complete(fail("CodeMode cell closed"));
    }
  }
}
