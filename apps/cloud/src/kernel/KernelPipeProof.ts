// @effect-diagnostics nodeBuiltinImport:off - verifies Node Buffer inputs against the portable pipe.
import { Buffer } from "node:buffer";
import { KernelPipe } from "./KernelPipe.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertPipeError(operation: () => unknown, expected: string): void {
  try {
    operation();
  } catch (error) {
    assert(
      error instanceof Error && "code" in error && error.code === expected,
      `Expected ${expected}, got ${String(error)}`,
    );
    return;
  }
  throw new Error(`Expected ${expected}, but the operation succeeded`);
}

function bytesAre(bytes: Uint8Array, count: number, value: number): boolean {
  if (bytes.byteLength < count) return false;
  for (let index = 0; index < count; index++) {
    if (bytes[index] !== value) return false;
  }
  return true;
}

/** Runs in a Durable Object fixture with only the real pipe and wake registry. */
export async function runKernelPipeProof() {
  const checks: { name: string; ok: boolean; error?: string }[] = [];
  const run = async (name: string, check: () => void | Promise<void>) => {
    try {
      await check();
      checks.push({ name, ok: true });
    } catch (error) {
      checks.push({
        name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  await run("blocked Buffer write owns its source bytes", async () => {
    const wakes = new KernelWakeRegistry();
    const pipe = new KernelPipe(wakes, 4096);
    try {
      pipe.tryWrite(new Uint8Array(4096));
      const source = Buffer.alloc(10, 2);
      const waiting = pipe.write(source);
      source.fill(9);
      pipe.tryReadInto(new Uint8Array(4096));
      assert((await waiting) === 10, "Blocked write did not finish");
      const received = new Uint8Array(10);
      assert(
        pipe.tryReadInto(received) === 10 && bytesAre(received, 10, 2),
        "Caller mutation changed blocked bytes",
      );
    } finally {
      wakes.dispose();
    }
  });

  await run("memory growth preserves large short-write semantics", async () => {
    const wakes = new KernelWakeRegistry();
    const pipe = new KernelPipe(wakes, 8192);
    try {
      pipe.tryWrite(new Uint8Array(8192));
      const memory = new WebAssembly.Memory({ initial: 1 });
      const source = new Uint8Array(memory.buffer, 0, 5000).fill(7);
      const waiting = pipe.write(source);
      memory.grow(1);
      pipe.tryReadInto(new Uint8Array(1));
      assert((await waiting) === 1, "Large write became atomic after memory growth");
      const received = new Uint8Array(8192);
      assert(
        pipe.tryReadInto(received) === 8192 && received[8191] === 7,
        "Detached source lost its byte",
      );
      assert(wakes.size === 0, "Short write retained its wake");
    } finally {
      wakes.dispose();
    }
  });

  await run("bounded buffer", () => {
    const wakes = new KernelWakeRegistry();
    const pipe = new KernelPipe(wakes, 4096);
    const payload = Uint8Array.from({ length: 4096 }, (_, index) => index % 251);
    try {
      assert(pipe.tryWrite(payload) === 4096, "Pipe did not accept its full capacity");
      assert(pipe.bufferedBytes === 4096, "Pipe exceeded or lost its bounded contents");
      assertPipeError(() => pipe.tryWrite(new Uint8Array([1])), "EAGAIN");
      assert(pipe.bufferedBytes === 4096, "Full pipe accepted bytes past capacity");

      const received = new Uint8Array(4096);
      assert(pipe.tryReadInto(received) === 4096, "Pipe did not return all buffered bytes");
      assert(
        received.every((byte, index) => byte === payload[index]),
        "Pipe changed byte order",
      );
      assert(Number(pipe.bufferedBytes) === 0, "Pipe retained bytes after a complete drain");
    } finally {
      wakes.dispose();
    }
  });

  await run("subscribe before attempt preserves an early pipe wake", async () => {
    const wakes = new KernelWakeRegistry();
    const pipe = new KernelPipe(wakes, 4096);
    const events: string[] = [];
    let detached = 0;
    const subscribe = pipe.subscribe.bind(pipe);
    const tryReadInto = pipe.tryReadInto.bind(pipe);
    try {
      pipe.subscribe = (direction) => {
        events.push("subscribe");
        const original = subscribe(direction);
        return (notify) => {
          events.push("registered");
          const unsubscribe = original(() => {
            events.push("wake");
            notify();
          });
          if (direction === "read") pipe.tryWrite(new Uint8Array([42]));
          return () => {
            detached++;
            unsubscribe();
          };
        };
      };
      pipe.tryReadInto = (target) => {
        events.push("attempt");
        return tryReadInto(target);
      };

      const received = new Uint8Array(1);
      assert((await pipe.readInto(received)) === 1, "Pipe read lost data written during subscribe");
      assert(received[0] === 42, "Pipe read returned the wrong byte");
      const registeredAt = events.indexOf("registered");
      const wakeAt = events.indexOf("wake");
      const attemptAt = events.indexOf("attempt");
      assert(
        registeredAt >= 0 && attemptAt >= 0 && registeredAt < attemptAt,
        "Read was attempted before its readiness subscription was installed",
      );
      assert(wakeAt >= 0 && wakeAt < attemptAt, "Early wake did not occur before the read attempt");
      assert(wakes.size === 0 && detached === 1, "Early wake leaked its subscription");
    } finally {
      wakes.dispose();
    }
  });

  await run("pipe wake is retained when it arrives before wait", async () => {
    const wakes = new KernelWakeRegistry();
    const pipe = new KernelPipe(wakes, 4096);
    let detached = 0;
    try {
      const subscribe = pipe.subscribe("read");
      const registered = wakes.register((notify) => {
        const unsubscribe = subscribe(notify);
        pipe.tryWrite(new Uint8Array([73]));
        return () => {
          detached++;
          unsubscribe();
        };
      });
      assert(registered.status === "ok", "Could not register pipe readiness");
      assert(
        (await wakes.wait(registered.value)).status === "ok",
        "Pipe wake delivered before wait was lost",
      );
      assert(wakes.size === 0 && detached === 1, "Consumed early wake leaked its subscription");
      const received = new Uint8Array(1);
      assert(
        pipe.tryReadInto(received) === 1 && received[0] === 73,
        "Pipe data was lost with its wake",
      );
    } finally {
      wakes.dispose();
    }
  });

  await run("PIPE_BUF writes are atomic", () => {
    const wakes = new KernelWakeRegistry();
    const pipe = new KernelPipe(wakes, 8192);
    const existing = new Uint8Array(8092).fill(7);
    const atomicWrite = new Uint8Array(200).fill(9);
    try {
      assert(pipe.tryWrite(existing) === existing.byteLength, "Could not create partial capacity");
      assert(pipe.bufferedBytes === 8092, "Pipe has the wrong starting occupancy");
      assertPipeError(() => pipe.tryWrite(atomicWrite), "EAGAIN");
      assert(pipe.bufferedBytes === 8092, "Small write was partially accepted below PIPE_BUF");

      const received = new Uint8Array(8192);
      assert(pipe.tryReadInto(received) === existing.byteLength, "Existing bytes were lost");
      assert(bytesAre(received, existing.byteLength, 7), "Failed atomic write changed pipe data");
      assertPipeError(() => pipe.tryReadInto(new Uint8Array(1)), "EAGAIN");
    } finally {
      wakes.dispose();
    }
  });

  await run("writer close is readable HUP and drains to EOF", () => {
    const wakes = new KernelWakeRegistry();
    const pipe = new KernelPipe(wakes, 4096);
    try {
      assert(pipe.tryWrite(new Uint8Array([3, 5, 8])) === 3, "Could not seed pipe contents");
      pipe.closeWriter();
      assert(pipe.ready("read"), "Writer close did not report read readiness");

      const first = new Uint8Array(2);
      assert(pipe.tryReadInto(first) === 2, "Pipe did not drain the first bytes");
      assert(first[0] === 3 && first[1] === 5, "Pipe changed bytes before EOF");
      const last = new Uint8Array(2);
      assert(pipe.tryReadInto(last) === 1 && last[0] === 8, "Pipe lost buffered data at HUP");
      assert(pipe.ready("read"), "EOF stopped reporting read readiness");
      assert(pipe.tryReadInto(last) === 0, "Closed writer did not produce EOF");
    } finally {
      wakes.dispose();
    }
  });

  await run("request cancellation releases the blocked reader", async () => {
    const wakes = new KernelWakeRegistry();
    const request = new AbortController();
    const pipe = new KernelPipe(wakes, 4096);
    let detached = 0;
    const subscribe = pipe.subscribe.bind(pipe);
    try {
      pipe.subscribe = (direction) => {
        const original = subscribe(direction);
        return (notify) => {
          const unsubscribe = original(notify);
          return () => {
            detached++;
            unsubscribe();
          };
        };
      };

      const waiting = pipe.readInto(new Uint8Array(1), { signal: request.signal });
      assert(wakes.size === 1, "Blocked read did not register a wake");
      request.abort();
      let cancelled = false;
      try {
        await waiting;
      } catch (error) {
        cancelled = error instanceof Error && "code" in error && error.code === "ECANCELED";
      }
      assert(cancelled, "Request cancellation did not stop the read");
      assert(
        Number(wakes.size) === 0 && detached === 1,
        "Cancelled read leaked its wake subscription",
      );

      assert(pipe.tryWrite(new Uint8Array([11])) === 1, "Cancelled read corrupted the pipe");
      const received = new Uint8Array(1);
      assert(
        pipe.tryReadInto(received) === 1 && received[0] === 11,
        "Pipe failed after cancellation",
      );
    } finally {
      wakes.dispose();
    }
  });

  return { ok: checks.every((check) => check.ok), checks };
}
