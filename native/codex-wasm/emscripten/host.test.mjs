import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";
import { createEmscriptenHost } from "./host.mjs";

// Until #1064 lands, point this at that checkout's KernelAbi.ts. The tests use
// the actual shared registry/pipe, never a copied implementation of their ABI.
const kernelUrl = process.env.SIGNALBOX_KERNEL_ABI_MODULE
  ? NodeURL.pathToFileURL(process.env.SIGNALBOX_KERNEL_ABI_MODULE)
  : new URL("../../../apps/cloud/src/kernel/KernelAbi.ts", import.meta.url);
const { KernelWakeRegistry, attemptKernelOperation } = await import(kernelUrl);
const { KernelPipe } = await import(new URL("./KernelPipe.ts", kernelUrl));
const POLLIN = 1,
  POLLOUT = 4,
  POLLHUP = 16,
  POLLNVAL = 32;

function fixture(t, options = {}) {
  const wakes = new KernelWakeRegistry({ ttlMs: options.ttlMs ?? 10_000 });
  const pipe = new KernelPipe(wakes, 4096);
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 3 });
  const subscriptions = new Set();
  let attempts = 0,
    registrations = 0;
  const endpoints = new Map([
    [7, "read"],
    [8, "write"],
  ]);
  const bridge = createEmscriptenHost({
    wakes,
    attemptKernelOperation,
    subscribeFd(request, notify) {
      registrations++;
      if (options.subscribeFd) return options.subscribeFd(request, notify, subscriptions, pipe);
      const direction = endpoints.get(request.fd);
      if (!direction) return () => {};
      const unsubscribe = pipe.subscribe(direction)(notify);
      subscriptions.add(notify);
      return () => {
        subscriptions.delete(notify);
        unsubscribe();
      };
    },
    tryPoll(requests) {
      attempts++;
      NodeAssert.ok(registrations >= attempts, "I/O was attempted before fd subscription");
      options.onAttempt?.(attempts);
      if (options.tryPoll) return options.tryPoll(requests, attempts, pipe);
      return {
        status: "ok",
        value: requests.map(({ fd, events }) => {
          if (fd < 0) return 0;
          const direction = endpoints.get(fd);
          if (!direction) return POLLNVAL;
          return pipe.ready(direction) ? events & (direction === "read" ? POLLIN : POLLOUT) : 0;
        }),
      };
    },
    capabilities: options.capabilities,
    signal: options.signal,
    clock: options.clock,
  });
  bridge.attach({ exports: { memory } });
  const api = bridge.imports.signalbox_emscripten;
  const view = () => new DataView(memory.buffer);
  const allocate = () => {
    NodeAssert.equal(api.reactor_new(80), 0);
    return view().getUint32(80, true);
  };
  const register = (fd, events, index = 0) => {
    view().setInt32(index * 8, fd, true);
    view().setInt16(index * 8 + 4, events, true);
    view().setInt16(index * 8 + 6, POLLHUP, true);
  };
  const poll = (handle, count = 1, timeout = -1) => api.reactor_poll(handle, 0, count, timeout, 64);
  const ready = () => view().getUint32(64, true);
  const flags = (index = 0) => view().getUint16(index * 8 + 6, true);
  t.after(() => {
    bridge.dispose();
    wakes.dispose();
  });
  return {
    wakes,
    pipe,
    memory,
    subscriptions,
    bridge,
    api,
    allocate,
    register,
    poll,
    ready,
    flags,
    get attempts() {
      return attempts;
    },
  };
}

NodeTest.test("requires shared dependencies and rejects unimplemented runtime features", (t) => {
  NodeAssert.throws(() => createEmscriptenHost({}), /shared kernel/);
  const f = fixture(t);
  NodeAssert.equal(f.api.runtime_require(1), 0);
  NodeAssert.equal(f.api.runtime_require(31), 138);
  NodeAssert.equal(f.api.runtime_require(32), 138);
  NodeAssert.equal(f.api.reactor_new(3), 28);
  NodeAssert.equal(f.bridge.activeReactors, 0);
});

NodeTest.test(
  "pipe read subscribes before attempt, wakes once, and refreshes grown memory",
  async (t) => {
    const f = fixture(t);
    const handle = f.allocate();
    f.register(7, POLLIN);
    const waiting = f.poll(handle);
    NodeAssert.equal(f.flags(), 0);
    NodeAssert.equal(f.attempts, 1);
    NodeAssert.equal(f.wakes.size, 1);
    NodeAssert.equal(f.subscriptions.size, 1);
    f.memory.grow(1);
    f.pipe.tryWrite(Uint8Array.of(3, 9));
    NodeAssert.equal(await waiting, 0);
    NodeAssert.equal(f.ready(), 1);
    NodeAssert.equal(f.flags(), POLLIN);
    const target = new Uint8Array(f.memory.buffer, 128, 2);
    NodeAssert.equal(f.pipe.tryReadInto(target), 2);
    NodeAssert.deepEqual([...target], [3, 9]);
    NodeAssert.equal(f.wakes.size, 0);
    NodeAssert.equal(f.subscriptions.size, 0);
  },
);

NodeTest.test(
  "an early notification is retained when the first attempt still would block",
  async (t) => {
    let first = true;
    const f = fixture(t, {
      subscribeFd(request, notify, subscriptions, pipe) {
        subscriptions.add(notify);
        const unsubscribe = pipe.subscribe("read")(notify);
        if (first) {
          first = false;
          pipe.tryWrite(Uint8Array.of(5));
        }
        return () => {
          subscriptions.delete(notify);
          unsubscribe();
        };
      },
      tryPoll(requests, attempts, pipe) {
        return attempts === 1
          ? { status: "would_block" }
          : { status: "ok", value: [pipe.ready("read") ? POLLIN : 0] };
      },
    });
    f.register(7, POLLIN);
    NodeAssert.equal(await f.poll(f.allocate()), 0);
    NodeAssert.equal(f.attempts, 2);
    NodeAssert.equal(f.flags(), POLLIN);
    NodeAssert.equal(f.wakes.size, 0);
    NodeAssert.equal(f.subscriptions.size, 0);
  },
);

NodeTest.test("spurious readiness retries I/O and resubscribes without poll-sleep", async (t) => {
  const retried = Promise.withResolvers();
  const f = fixture(t, {
    onAttempt: (attempts) => {
      if (attempts === 2) retried.resolve();
    },
  });
  f.register(7, POLLIN);
  const waiting = f.poll(f.allocate());
  [...f.subscriptions][0]();
  await retried.promise;
  NodeAssert.equal(f.attempts, 2);
  NodeAssert.equal(f.wakes.size, 1);
  NodeAssert.equal(f.subscriptions.size, 1);
  f.pipe.tryWrite(Uint8Array.of(1));
  NodeAssert.equal(await waiting, 0);
  NodeAssert.equal(f.attempts, 3);
  NodeAssert.equal(f.wakes.size, 0);
});

NodeTest.test("writer close wakes a reader and the next pipe I/O returns EOF", async (t) => {
  const f = fixture(t);
  f.register(7, POLLIN);
  const handle = f.allocate();
  const waiting = f.poll(handle);
  f.pipe.tryWrite(Uint8Array.of(4, 6));
  f.pipe.closeWriter();
  NodeAssert.equal(await waiting, 0);
  NodeAssert.equal(f.flags(), POLLIN);
  const byte = new Uint8Array(1);
  NodeAssert.equal(f.pipe.tryReadInto(byte), 1);
  NodeAssert.equal(byte[0], 4);
  NodeAssert.equal(await f.poll(handle, 1, 0), 0);
  NodeAssert.equal(f.flags(), POLLIN);
  NodeAssert.equal(f.pipe.tryReadInto(byte), 1);
  NodeAssert.equal(byte[0], 6);
  NodeAssert.equal(await f.poll(handle, 1, 0), 0);
  NodeAssert.equal(f.flags(), POLLIN);
  NodeAssert.equal(f.pipe.tryReadInto(byte), 0);
  NodeAssert.equal(f.wakes.size, 0);
});

NodeTest.test("reader close wakes a blocked writer and preserves EPIPE", async (t) => {
  const f = fixture(t);
  NodeAssert.equal(f.pipe.tryWrite(new Uint8Array(4096)), 4096);
  NodeAssert.throws(() => f.pipe.tryWrite(Uint8Array.of(1)), { code: "EAGAIN" });
  f.register(8, POLLOUT);
  const waiting = f.poll(f.allocate());
  f.pipe.closeReader();
  NodeAssert.equal(await waiting, 0);
  NodeAssert.equal(f.flags(), POLLOUT);
  NodeAssert.throws(() => f.pipe.tryWrite(Uint8Array.of(1)), { code: "EPIPE" });
  NodeAssert.equal(f.wakes.size, 0);
});

NodeTest.test("poll preserves backend HUP and invalid-fd flags", async (t) => {
  const f = fixture(t, { tryPoll: () => ({ status: "ok", value: [POLLHUP, POLLNVAL] }) });
  f.register(7, 0);
  f.register(99, POLLIN, 1);
  NodeAssert.equal(await f.poll(f.allocate(), 2), 0);
  NodeAssert.equal(f.ready(), 2);
  NodeAssert.equal(f.flags(), POLLHUP);
  NodeAssert.equal(f.flags(1), POLLNVAL);
});

NodeTest.test("wake before poll is sticky and does not invent an fd event", async (t) => {
  const f = fixture(t);
  const handle = f.allocate();
  NodeAssert.equal(f.api.reactor_wake(handle), 0);
  NodeAssert.equal(await f.poll(handle, 0), 0);
  NodeAssert.equal(f.ready(), 0);
  NodeAssert.equal(f.wakes.size, 0);
});

NodeTest.test("one pending poll per reactor; drop cancels and unsubscribes", async (t) => {
  const f = fixture(t);
  f.register(7, POLLIN);
  const handle = f.allocate();
  const waiting = f.poll(handle);
  NodeAssert.equal(await f.poll(handle), 7);
  NodeAssert.equal(f.api.reactor_drop(handle), 0);
  NodeAssert.equal(await waiting, 11);
  NodeAssert.equal(f.api.reactor_drop(handle), 8);
  NodeAssert.equal(f.wakes.size, 0);
  NodeAssert.equal(f.subscriptions.size, 0);
});

NodeTest.test("request abort cancels the wait and prevents new operations", async (t) => {
  const controller = new AbortController();
  const f = fixture(t, { signal: controller.signal });
  f.register(7, POLLIN);
  const waiting = f.poll(f.allocate());
  controller.abort();
  NodeAssert.equal(await waiting, 11);
  NodeAssert.equal(f.api.runtime_require(1), 11);
  NodeAssert.equal(f.api.reactor_new(80), 11);
  NodeAssert.equal(f.wakes.size, 0);
  NodeAssert.equal(f.subscriptions.size, 0);
  NodeAssert.equal(f.bridge.activeReactors, 0);
});

NodeTest.test(
  "closing one reactor does not close a shared pipe endpoint or other waiters",
  async (t) => {
    const f = fixture(t);
    f.register(7, POLLIN);
    const first = f.allocate(),
      second = f.allocate();
    const a = f.poll(first),
      b = f.poll(second);
    NodeAssert.equal(f.wakes.size, 2);
    f.api.reactor_drop(first);
    NodeAssert.equal(await a, 11);
    NodeAssert.equal(f.wakes.size, 1);
    f.pipe.tryWrite(Uint8Array.of(8));
    NodeAssert.equal(await b, 0);
    NodeAssert.equal(f.pipe.tryReadInto(new Uint8Array(1)), 1);
    NodeAssert.equal(f.wakes.size, 0);
  },
);

NodeTest.test("deadline notification suspends once and releases its timer", async (t) => {
  let now = 0;
  const timers = new Set();
  const f = fixture(t, {
    clock: {
      now: () => now,
      setTimeout: (notify) => {
        timers.add(notify);
        return notify;
      },
      clearTimeout: (notify) => timers.delete(notify),
    },
  });
  const waiting = f.poll(f.allocate(), 0, 10);
  NodeAssert.equal(timers.size, 1);
  now = 10;
  [...timers][0]();
  NodeAssert.equal(await waiting, 0);
  NodeAssert.equal(f.ready(), 0);
  NodeAssert.equal(timers.size, 0);
  NodeAssert.equal(f.wakes.size, 0);
});

NodeTest.test("an absent fd backend returns unsupported; no clock-only fallback", async (t) => {
  const wakes = new KernelWakeRegistry();
  const bridge = createEmscriptenHost({ wakes, attemptKernelOperation });
  t.after(() => {
    bridge.dispose();
    wakes.dispose();
  });
  const memory = new WebAssembly.Memory({ initial: 1 });
  bridge.attach({ exports: { memory } });
  const api = bridge.imports.signalbox_emscripten;
  NodeAssert.equal(api.reactor_new(80), 0);
  const view = new DataView(memory.buffer);
  view.setInt32(0, 7, true);
  view.setInt16(4, POLLIN, true);
  NodeAssert.equal(await api.reactor_poll(view.getUint32(80, true), 0, 1, -1, 64), 138);
  NodeAssert.equal(wakes.size, 0);
});

NodeTest.test("partial subscription failure cleans up every fd already subscribed", async (t) => {
  const f = fixture(t, {
    subscribeFd(request, notify, subscriptions, pipe) {
      if (request.fd === 8) throw new Error("device subscription failed");
      subscriptions.add(notify);
      const unsubscribe = pipe.subscribe("read")(notify);
      return () => {
        subscriptions.delete(notify);
        unsubscribe();
      };
    },
  });
  f.register(7, POLLIN);
  f.register(8, POLLOUT, 1);
  NodeAssert.equal(await f.poll(f.allocate(), 2), 29);
  NodeAssert.equal(f.wakes.size, 0);
  NodeAssert.equal(f.subscriptions.size, 0);
});

NodeTest.test("malformed backend output and kernel errors stay visible", async (t) => {
  const f = fixture(t, { tryPoll: () => ({ status: "ok", value: [] }) });
  f.register(7, POLLIN);
  NodeAssert.equal(await f.poll(f.allocate()), 29);
  const g = fixture(t, { tryPoll: () => ({ status: "error", error: { code: "UNSUPPORTED" } }) });
  g.register(7, POLLIN);
  NodeAssert.equal(await g.poll(g.allocate()), 138);
  NodeAssert.equal(f.wakes.size + g.wakes.size, 0);
});

NodeTest.test(
  "bridge disposal leaves unrelated shared-registry registrations owned by their caller",
  (t) => {
    const f = fixture(t);
    const registration = f.wakes.register(() => () => {});
    NodeAssert.equal(registration.status, "ok");
    f.bridge.dispose();
    NodeAssert.equal(f.wakes.has(registration.value), true);
    f.wakes.release(registration.value);
    NodeAssert.equal(f.wakes.size, 0);
  },
);
