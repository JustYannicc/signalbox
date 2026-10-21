import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { KernelPipe } from "./KernelPipe.ts";
import { createKernelSessionStdio } from "./KernelSessionStdio.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";

function observe<T>(pending: Promise<T>) {
  const settled = vi.fn();
  const result = pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  void result.then(settled);
  return { result, settled };
}

afterEach(() => vi.useRealTimers());

describe("pipe notification renewal", () => {
  it.each(["data", "eof", "cancel", "reader-close", "dispose"] as const)(
    "keeps an idle reader pending across notification expiry until %s",
    async (finish) => {
      vi.useFakeTimers();
      const wakes = new KernelWakeRegistry({ ttlMs: 50 });
      const pipe = new KernelPipe(wakes);
      const abort = new AbortController();
      const target = new Uint8Array(1);
      const reading = observe(pipe.readInto(target, { signal: abort.signal }));
      try {
        await vi.advanceTimersByTimeAsync(125);
        expect(reading.settled).not.toHaveBeenCalled();
        expect(wakes.size).toBe(1);
        if (finish === "data") pipe.tryWrite(Uint8Array.of(42));
        if (finish === "eof") pipe.closeWriter();
        if (finish === "cancel") abort.abort();
        if (finish === "reader-close") pipe.closeReader();
        if (finish === "dispose") wakes.dispose();
        const result = await reading.result;
        if (finish === "data") {
          expect(result).toEqual({ value: 1 });
          expect(target[0]).toBe(42);
        } else if (finish === "eof") expect(result).toEqual({ value: 0 });
        else
          expect(result).toMatchObject({
            error: { code: finish === "reader-close" ? "EBADF" : "ECANCELED" },
          });
        expect(wakes.size).toBe(0);
      } finally {
        wakes.dispose();
        await reading.result;
      }
    },
  );

  it.each(["space", "reader-close", "cancel"] as const)(
    "keeps a blocked writer pending across notification expiry until %s",
    async (finish) => {
      vi.useFakeTimers();
      const wakes = new KernelWakeRegistry({ ttlMs: 50 });
      const pipe = new KernelPipe(wakes, 4096);
      const abort = new AbortController();
      pipe.tryWrite(new Uint8Array(4096));
      const writing = observe(pipe.write(Uint8Array.of(7), { signal: abort.signal }));
      try {
        await vi.advanceTimersByTimeAsync(125);
        expect(writing.settled).not.toHaveBeenCalled();
        expect(wakes.size).toBe(1);
        if (finish === "space") pipe.tryReadInto(new Uint8Array(4096));
        if (finish === "reader-close") pipe.closeReader();
        if (finish === "cancel") abort.abort();
        const result = await writing.result;
        if (finish === "space") {
          expect(result).toEqual({ value: 1 });
          const target = new Uint8Array(1);
          expect(pipe.tryReadInto(target)).toBe(1);
          expect(target[0]).toBe(7);
        } else
          expect(result).toMatchObject({
            error: { code: finish === "reader-close" ? "EPIPE" : "ECANCELED" },
          });
        expect(wakes.size).toBe(0);
      } finally {
        wakes.dispose();
        await writing.result;
      }
    },
  );

  it.each(["data", "eof", "cancel", "dispose"] as const)(
    "renews descriptor readiness notifications until %s",
    async (finish) => {
      vi.useFakeTimers();
      const wakes = new KernelWakeRegistry({ ttlMs: 50 });
      const stdio = createKernelSessionStdio(wakes);
      const abort = new AbortController();
      const poll = stdio.stdio[0].poll;
      if (poll === undefined) throw new Error("Missing stdin readiness port");
      const readiness = observe(Promise.resolve(poll("read", abort.signal)));
      const input = stdio.stdin.getWriter();
      try {
        await vi.advanceTimersByTimeAsync(125);
        expect(readiness.settled).not.toHaveBeenCalled();
        if (finish === "data") await input.write(Uint8Array.of(9));
        if (finish === "eof") await input.close();
        if (finish === "cancel") abort.abort();
        if (finish === "dispose") wakes.dispose();
        const result = await readiness.result;
        if (finish === "data") expect(result).toEqual({ value: { bytes: 1n } });
        else if (finish === "eof") expect(result).toEqual({ value: { bytes: 0n, hangup: true } });
        else expect(result).toMatchObject({ error: { code: "ECANCELED" } });
      } finally {
        wakes.dispose();
        input.releaseLock();
        await stdio.dispose();
        await readiness.result;
        expect(wakes.size).toBe(0);
      }
    },
  );

  it("keeps the session stdout stream usable after an idle notification expires", async () => {
    vi.useFakeTimers();
    const wakes = new KernelWakeRegistry({ ttlMs: 50 });
    const stdio = createKernelSessionStdio(wakes);
    const output = stdio.stdout.getReader();
    const reading = observe(output.read());
    try {
      await vi.advanceTimersByTimeAsync(125);
      expect(reading.settled).not.toHaveBeenCalled();
      const write = stdio.stdio[1].write;
      if (write === undefined) throw new Error("Missing stdout write port");
      expect(await write(Uint8Array.of(11), 0)).toBe(1);
      expect(await reading.result).toEqual({ value: { done: false, value: Uint8Array.of(11) } });
      stdio.finish();
      expect(await output.read()).toEqual({ done: true, value: undefined });
    } finally {
      wakes.dispose();
      output.releaseLock();
      await stdio.dispose();
      await reading.result;
      expect(wakes.size).toBe(0);
    }
  });
});
