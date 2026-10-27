import { vi } from "vite-plus/test";
import { KernelPipe } from "../../kernel/KernelPipe.ts";
import type { KernelWakeRegistry, WakeSubscription } from "../../kernel/KernelWakeRegistry.ts";

type Details = Record<string, unknown>;
type WakeState = Details & { released?: number; returned?: number };

export function traceReaderWakes(
  wakes: KernelWakeRegistry,
  record: (event: string, details?: Details) => number,
  operation: () => number | undefined,
) {
  const subscriptions = new WeakMap<WakeSubscription, { pipe: number; direction: string }>();
  const pipes = new Map<KernelPipe, number>();
  const tokens = new Map<string, WakeState>();
  let evictedTokens = 0;
  const state = (id: string) => {
    let value = tokens.get(id);
    if (value === undefined) {
      if (tokens.size === 4096) {
        tokens.delete(tokens.keys().next().value!);
        evictedTokens++;
      }
      value = {};
      tokens.set(id, value);
    }
    return value;
  };
  const subscribe = KernelPipe.prototype.subscribe;
  const subscribeSpy = vi.spyOn(KernelPipe.prototype, "subscribe").mockImplementation(function (
    this: KernelPipe,
    direction,
  ) {
    const result = subscribe.call(this, direction);
    let pipe = pipes.get(this);
    if (pipe === undefined) {
      pipe = pipes.size + 1;
      pipes.set(this, pipe);
    }
    subscriptions.set(result, { pipe, direction });
    return result;
  });
  const register = wakes.register.bind(wakes);
  const registerSpy = vi.spyOn(wakes, "register").mockImplementation((subscription) => {
    const result = register(subscription);
    if (result.status === "ok") {
      const details = { ...subscriptions.get(subscription), operation: operation() };
      Object.assign(state(result.value.id), details, {
        registered: record("wake-register", { tokenId: result.value.id, ...details }),
      });
    }
    return result;
  });
  const signal = wakes.signal.bind(wakes);
  const signalSpy = vi.spyOn(wakes, "signal").mockImplementation((token) => {
    const delivered = signal(token);
    const sequence = record("wake-signal", { tokenId: token.id, delivered });
    if (delivered) state(token.id).signaled = sequence;
    return delivered;
  });
  const wait = wakes.wait.bind(wakes);
  const waitSpy = vi.spyOn(wakes, "wait").mockImplementation((token, signal) => {
    const value = state(token.id);
    value.waiting = record("wake-wait", { tokenId: token.id });
    const pending = wait(token, signal);
    void pending.then((result) => {
      value.returned = record("wake-return", { tokenId: token.id, result });
    });
    return pending;
  });
  const release = wakes.release.bind(wakes);
  const releaseSpy = vi.spyOn(wakes, "release").mockImplementation((token) => {
    state(token.id).released = record("wake-release", { tokenId: token.id });
    return release(token);
  });
  return {
    snapshot() {
      return {
        evictedTokens,
        tokens: [...tokens].map(([tokenId, value]) => ({
          tokenId,
          ...value,
          registeredNow: wakes.has({ id: tokenId }),
        })),
        pipes: [...pipes].map(([pipe, id]) => ({
          id,
          bufferedBytes: pipe.bufferedBytes,
          readable: pipe.ready("read"),
          writable: pipe.ready("write"),
        })),
      };
    },
    restore() {
      subscribeSpy.mockRestore();
      registerSpy.mockRestore();
      signalSpy.mockRestore();
      waitSpy.mockRestore();
      releaseSpy.mockRestore();
    },
  };
}
