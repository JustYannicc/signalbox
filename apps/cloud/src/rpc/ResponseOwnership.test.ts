import { describe, expect, it } from "@effect/vitest";

import { retainRpcResponse } from "./Resources.ts";

const disposable = <A extends object>(value: A, onDispose: () => void): A => {
  Object.defineProperty(value, Symbol.dispose, { value: onDispose });
  return value;
};

describe("retainRpcResponse", () => {
  it("retains stream and both disposal failures", async () => {
    const primary = new Error("read failed");
    const responseFailure = new Error("response disposal failed");
    const resultFailure = new Error("container disposal failed");
    const response = disposable(
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            throw primary;
          },
        }),
      ),
      () => {
        throw responseFailure;
      },
    );
    const result = disposable({}, () => {
      throw resultFailure;
    });
    const copy = await retainRpcResponse(response, { result });
    await expect(copy.text()).rejects.toMatchObject({
      cause: primary,
      errors: [primary, expect.objectContaining({ errors: [responseFailure, resultFailure] })],
    });
  });

  it("keeps the response and enclosing result through EOF", async () => {
    let send: ((chunk: string) => void) | undefined;
    let close: (() => void) | undefined;
    let responseDisposals = 0;
    let resultDisposals = 0;
    const response = disposable(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            send = (chunk) => controller.enqueue(new TextEncoder().encode(chunk));
            close = () => controller.close();
          },
        }),
      ),
      () => responseDisposals++,
    );
    const result = disposable({}, () => resultDisposals++);
    const copy = await retainRpcResponse(response, { result });
    const reader = copy.body!.getReader();

    const first = reader.read();
    send?.("first");
    expect(new TextDecoder().decode((await first).value)).toBe("first");
    expect(responseDisposals).toBe(0);
    expect(resultDisposals).toBe(0);

    const final = reader.read();
    close?.();
    expect((await final).done).toBe(true);
    expect(responseDisposals).toBe(1);
    expect(resultDisposals).toBe(1);
  });

  it("releases both results on cancellation and preserves read errors", async () => {
    let responseDisposals = 0;
    let resultDisposals = 0;
    let cancelled = 0;
    const response = disposable(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancelled++;
          },
        }),
      ),
      () => responseDisposals++,
    );
    const result = disposable({}, () => resultDisposals++);
    const copy = await retainRpcResponse(response, { result });
    const reader = copy.body!.getReader();
    await reader.read();
    await reader.cancel("turn stopped");
    expect(cancelled).toBe(1);
    expect(responseDisposals).toBe(1);
    expect(resultDisposals).toBe(1);

    const sourceError = new Error("upstream read failed");
    let failedResponseDisposals = 0;
    let failedResultDisposals = 0;
    const failedResponse = disposable(
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            throw sourceError;
          },
        }),
      ),
      () => failedResponseDisposals++,
    );
    const failedResult = disposable({}, () => failedResultDisposals++);
    await expect(
      (await retainRpcResponse(failedResponse, { result: failedResult })).text(),
    ).rejects.toBe(sourceError);
    expect(failedResponseDisposals).toBe(1);
    expect(failedResultDisposals).toBe(1);
  });

  it("copies empty responses before releasing their RPC results", async () => {
    let responseDisposals = 0;
    let resultDisposals = 0;
    const response = disposable(new Response(null, { status: 204 }), () => responseDisposals++);
    const result = disposable({}, () => resultDisposals++);

    const copy = await retainRpcResponse(response, { result });

    expect(copy).not.toBe(response);
    expect(copy.status).toBe(204);
    expect(responseDisposals).toBe(1);
    expect(resultDisposals).toBe(1);
  });

  it("cancels an unreturnable stream before releasing its RPC results", async () => {
    let beginCancel: (() => void) | undefined;
    let finishCancel: (() => void) | undefined;
    let onResultDisposed: (() => void) | undefined;
    let responseDisposals = 0;
    let resultDisposals = 0;
    const cancelStarted = new Promise<void>((resolve) => {
      beginCancel = resolve;
    });
    const cancellation = new Promise<void>((resolve) => {
      finishCancel = resolve;
    });
    const resultDisposed = new Promise<void>((resolve) => {
      onResultDisposed = resolve;
    });
    const response = disposable(
      {
        status: 204,
        statusText: "",
        headers: new Headers(),
        body: new ReadableStream<Uint8Array>({
          cancel() {
            beginCancel?.();
            return cancellation;
          },
        }),
      } as Response,
      () => responseDisposals++,
    );
    const result = disposable({}, () => {
      resultDisposals++;
      onResultDisposed?.();
    });

    const rejected = expect(retainRpcResponse(response, { result })).rejects.toThrow();
    await cancelStarted;
    expect(responseDisposals).toBe(0);
    expect(resultDisposals).toBe(0);

    finishCancel?.();
    await resultDisposed;
    await rejected;
    expect(responseDisposals).toBe(1);
    expect(resultDisposals).toBe(1);
  });
});
