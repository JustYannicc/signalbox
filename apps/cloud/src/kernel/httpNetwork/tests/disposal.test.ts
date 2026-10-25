import { describe, expect, it, vi } from "vite-plus/test";
import { fixture } from "./fixture.ts";

const request = "GET / HTTP/1.1\r\nHost: api.example\r\n\r\n";

describe("HTTP transport disposal ownership", () => {
  it.each([false, true])(
    "joins the fetch and late body cancellation after final fd close: %s",
    async (closeFirst) => {
      vi.useFakeTimers();
      const called = Promise.withResolvers<Request>();
      const reply = Promise.withResolvers<Response>();
      const cancelling = Promise.withResolvers<void>();
      const acknowledgement = Promise.withResolvers<void>();
      const f = fixture(async (input) => {
        called.resolve(input);
        return reply.promise;
      });
      const response = new Response(
        new ReadableStream({
          cancel() {
            cancelling.resolve();
            return acknowledgement.promise;
          },
        }),
      );
      try {
        const fd = f.open();
        expect(f.send(fd, request)).toBe(0);
        const input = await called.promise;
        if (closeFirst) expect(f.imports.net_close(fd)).toBe(0);
        let disposed = false;
        const disposing = f.host.dispose().then(() => {
          disposed = true;
        });
        expect(input.signal.aborted).toBe(true);
        // Drain runnable promise work without settling either external owner.
        await vi.advanceTimersByTimeAsync(0);
        expect(disposed).toBe(false);
        reply.resolve(response);
        await cancelling.promise;
        await vi.advanceTimersByTimeAsync(0);
        expect(disposed).toBe(false);
        acknowledgement.resolve();
        await disposing;
        expect(disposed).toBe(true);
      } finally {
        reply.resolve(response);
        acknowledgement.resolve();
        await f.close();
        vi.useRealTimers();
      }
    },
  );

  it("keeps disposal pending until an abort-ignoring fetch rejects", async () => {
    vi.useFakeTimers();
    const called = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<Response>();
    const f = fixture(async () => {
      called.resolve();
      return reply.promise;
    });
    try {
      const fd = f.open();
      expect(f.send(fd, request)).toBe(0);
      await called.promise;
      let disposed = false;
      const disposing = f.host.dispose().then(() => {
        disposed = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(disposed).toBe(false);
      reply.reject(new Error("Transport acknowledged cancellation"));
      await disposing;
      expect(disposed).toBe(true);
    } finally {
      reply.reject(new Error("Release test transport"));
      await f.close();
      vi.useRealTimers();
    }
  });
});
