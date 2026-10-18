import { describe, expect, it } from "@effect/vitest";
import { withPreflight } from "./preflight.ts";

function passthrough() {
  let ended = false;
  let stream: ReadableStream<Uint8Array> | null = null;
  return {
    async fetch(request: Request) {
      if (!request.body) throw new Error("Missing preflight body");
      stream = request.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
          },
          flush() {
            ended = true;
          },
        }),
      );
      return new Response(stream);
    },
    ended: () => ended,
    locked: () => stream?.locked,
  };
}

describe("WorkerLoader preflight session", () => {
  it("holds the native body source through validation and fixture completion, then reaches EOF", async () => {
    const held = passthrough();
    const validation = Promise.withResolvers<void>();
    const validated = Promise.withResolvers<void>();
    const result = Promise.withResolvers<number>();
    const invoked = Promise.withResolvers<void>();
    const session = withPreflight(
      held.fetch,
      async () => {
        validated.resolve();
        await validation.promise;
      },
      async () => {
        expect(held.ended()).toBe(false);
        invoked.resolve();
        return result.promise;
      },
    );
    await validated.promise;
    expect(held.locked()).toBe(true);
    expect(held.ended()).toBe(false);
    validation.resolve();
    await invoked.promise;
    expect(held.ended()).toBe(false);
    result.resolve(42);
    expect(await session).toBe(42);
    expect(held.ended()).toBe(true);
    expect(held.locked()).toBe(false);
  });

  it("rejects early EOF and never invokes the fixture after pending validation settles", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(new Uint8Array([1]));
      },
    });
    const validation = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let calls = 0;
    const session = withPreflight(
      async () => new Response(stream),
      async () => {
        started.resolve();
        await validation.promise;
      },
      async () => {
        calls++;
      },
    );
    const failed = expect(session).rejects.toThrow("preflight ended");
    await started.promise;
    controller?.close();
    await failed;
    validation.resolve();
    await validation.promise;
    expect(calls).toBe(0);
    expect(stream.locked).toBe(false);
  });

  it.each(["validation", "fixture"])("releases the preflight on %s failure", async (stage) => {
    const held = passthrough();
    const failure = new Error(stage);
    let calls = 0;
    await expect(
      withPreflight(
        held.fetch,
        async () => {
          if (stage === "validation") throw failure;
        },
        async () => {
          calls++;
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(calls).toBe(stage === "validation" ? 0 : 1);
    expect(held.ended()).toBe(true);
    expect(held.locked()).toBe(false);
  });

  it("fails closed when a runtime completes the stream instead of keeping it active", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    let calls = 0;
    await expect(
      withPreflight(
        async () => new Response(body),
        async () => {},
        async () => {
          calls++;
        },
      ),
    ).rejects.toThrow("preflight ended");
    expect(calls).toBe(0);
    expect(body.locked).toBe(false);
  });
});
