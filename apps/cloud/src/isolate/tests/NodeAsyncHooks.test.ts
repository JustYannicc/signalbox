// @effect-diagnostics nodeBuiltinImport:off - native Node supplies propagation; the subclass models workerd's missing enterWith.
import * as NodeAsyncHooks from "node:async_hooks";
import { describe, expect, it } from "@effect/vitest";
import { createNodeAsyncHooks } from "../NodeAsyncHooks.ts";
import { createNodeBridge } from "../NodeBridge.ts";

const unsupported = new Error("asyncLocalStorage.enterWith() is not implemented");

class NativeWithoutEnter<T> extends NodeAsyncHooks.AsyncLocalStorage<T> {
  readonly #storage: NodeAsyncHooks.AsyncLocalStorage<T>;

  constructor(options?: ConstructorParameters<typeof NodeAsyncHooks.AsyncLocalStorage<T>>[0]) {
    super(options);
    this.#storage = new NodeAsyncHooks.AsyncLocalStorage<T>(options);
  }

  override run<R, Args extends unknown[]>(
    store: T,
    callback: (...args: Args) => R,
    ...args: Args
  ): R {
    return this.#storage.run(store, callback, ...args);
  }

  override getStore() {
    return this.#storage.getStore();
  }

  override disable(): void {
    this.#storage.disable();
  }

  override enterWith(_store: T): never {
    throw unsupported;
  }
}

function createFixture() {
  return createNodeAsyncHooks({ ...NodeAsyncHooks, AsyncLocalStorage: NativeWithoutEnter });
}

describe("Node async context compatibility", () => {
  it("restores an already-active tracing context through nested runs", () => {
    const { AsyncLocalStorage } = createFixture();
    const storage = new AsyncLocalStorage<object>();
    const context = {};
    expect(
      storage.run(context, () => {
        const previous = storage.getStore();
        const current = storage.getStore();
        try {
          return storage.run(context, () => storage.getStore());
        } finally {
          if (storage.getStore() === current) storage.enterWith(previous!);
        }
      }),
    ).toBe(context);
    expect(storage.getStore()).toBeUndefined();
  });

  it("keeps interleaved async branches and captured contexts separate", async () => {
    const { AsyncLocalStorage } = createFixture();
    const storage = new AsyncLocalStorage<object>();
    const a = {};
    const b = {};
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = storage.run(a, async () => {
      storage.enterWith(a);
      const snapshot = AsyncLocalStorage.snapshot();
      await gate;
      expect(storage.getStore()).toBe(a);
      storage.enterWith(a);
      return snapshot;
    });
    const second = storage.run(b, async () => {
      storage.enterWith(b);
      await Promise.resolve();
      expect(storage.getStore()).toBe(b);
      release();
    });
    const [snapshot] = await Promise.all([first, second]);
    expect(
      storage.run(b, () =>
        snapshot(() => {
          storage.enterWith(a);
          return storage.getStore();
        }),
      ),
    ).toBe(a);
    expect(storage.getStore()).toBeUndefined();
  });

  it("preserves native errors for actual switches and calls outside run", () => {
    const { AsyncLocalStorage } = createFixture();
    const storage = new AsyncLocalStorage<object | undefined>();
    const current = {};
    expect(() => storage.enterWith(current)).toThrow(unsupported);
    expect(() => storage.enterWith(undefined)).toThrow(unsupported);
    storage.run(current, () => {
      expect(() => storage.enterWith({})).toThrow(unsupported);
      expect(storage.getStore()).toBe(current);
    });
  });

  it("does not treat default values or disabled scopes as entered contexts", () => {
    const { AsyncLocalStorage } = createFixture();
    const context = {};
    const storage = new AsyncLocalStorage<object>({ defaultValue: context });
    expect(() => storage.enterWith(context)).toThrow(unsupported);
    storage.run(context, () => {
      storage.disable();
      expect(() => storage.enterWith(context)).toThrow(unsupported);
    });
  });

  it("restores context after throws and preserves callback arguments", () => {
    const { AsyncLocalStorage } = createFixture();
    const storage = new AsyncLocalStorage<object>();
    const context = {};
    const failure = new Error("callback failed");
    expect(() =>
      storage.run(context, () => {
        try {
          throw failure;
        } finally {
          storage.enterWith(context);
        }
      }),
    ).toThrow(failure);
    expect(storage.getStore()).toBeUndefined();
    expect(storage.run(context, (a, b) => a + b, 2, 3)).toBe(5);
  });

  it("keeps native constructors untouched and exposes one module through the bridge", () => {
    const module = createFixture();
    const nativeEnter = NodeAsyncHooks.AsyncLocalStorage.prototype.enterWith;
    const bridge = createNodeBridge({ async_hooks: module });
    expect(bridge.require("node:async_hooks")).toBe(bridge.require("async_hooks"));
    expect(module.default).toBe(module);
    expect(module.AsyncResource).toBe(NodeAsyncHooks.AsyncResource);
    expect(NodeAsyncHooks.AsyncLocalStorage.prototype.enterWith).toBe(nativeEnter);
    expect(module.AsyncLocalStorage).not.toBe(NativeWithoutEnter);
  });

  it("preserves context switching when the native runtime supports it", () => {
    const { AsyncLocalStorage } = createNodeAsyncHooks();
    const storage = new AsyncLocalStorage<object>();
    const first = {};
    const second = {};
    storage.run(first, () => {
      storage.enterWith(second);
      expect(storage.getStore()).toBe(second);
    });
    expect(storage.getStore()).toBeUndefined();
  });
});
