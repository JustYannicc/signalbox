// @effect-diagnostics nodeBuiltinImport:off - async context propagation remains with the worker runtime.
import * as NodeAsyncHooks from "node:async_hooks";

export function createNodeAsyncHooks(native = NodeAsyncHooks) {
  class AsyncLocalStorage<T> extends native.AsyncLocalStorage<T> {
    readonly #scopes = new native.AsyncLocalStorage<{ store: T }>();

    override run<R, Args extends unknown[]>(
      store: T,
      callback: (...args: Args) => R,
      ...args: Args
    ): R {
      return this.#scopes.run({ store }, () => super.run(store, callback, ...args));
    }

    override enterWith(store: T): void {
      const scope = this.#scopes.getStore();
      // Restoring the current run's store changes no context and needs no native enterWith.
      if (scope && Object.is(scope.store, store) && Object.is(super.getStore(), store)) return;
      super.enterWith(store);
    }

    override disable(): void {
      super.disable();
      this.#scopes.disable();
    }
  }

  const module = { ...native, AsyncLocalStorage };
  return Object.freeze(Object.assign(module, { default: module }));
}
