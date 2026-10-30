// @effect-diagnostics nodeBuiltinImport:off - The native runtime owns async-context propagation.
import type * as NodeAsyncHooks from "node:async_hooks";
import { markNodeBuiltinCapability } from "./NodeBuiltinCapabilities.ts";
import { NodeBuiltinUnsupportedError } from "./NodeBuiltinFailure.ts";

export function createWorkerdAsyncResource(native: typeof NodeAsyncHooks.AsyncResource) {
  class AsyncResource {
    readonly #native: NodeAsyncHooks.AsyncResource;

    constructor(type: string, options?: NodeAsyncHooks.AsyncResourceOptions | number) {
      if (
        typeof options === "number" ||
        options?.triggerAsyncId !== undefined ||
        options?.requireManualDestroy
      ) {
        throw new NodeBuiltinUnsupportedError("async_hooks.AsyncResource lifecycle options");
      }
      this.#native = new native(type);
    }

    bind<Args extends unknown[], Result>(callback: (...args: Args) => Result, thisArg?: unknown) {
      const bound = this.#native.bind(thisArg === undefined ? callback : callback.bind(thisArg));
      Object.defineProperty(bound, "asyncResource", { value: this, configurable: true });
      return bound;
    }

    runInAsyncScope<This, Args extends unknown[], Result>(
      callback: (this: This, ...args: Args) => Result,
      thisArg: This,
      ...args: Args
    ) {
      return this.#native.runInAsyncScope(callback, thisArg, ...args);
    }

    asyncId(): never {
      throw new NodeBuiltinUnsupportedError("async_hooks.AsyncResource.asyncId");
    }
    triggerAsyncId(): never {
      throw new NodeBuiltinUnsupportedError("async_hooks.AsyncResource.triggerAsyncId");
    }
    emitDestroy(): never {
      throw new NodeBuiltinUnsupportedError("async_hooks.AsyncResource.emitDestroy");
    }

    static bind<Args extends unknown[], Result>(
      callback: (...args: Args) => Result,
      type?: string,
      thisArg?: unknown,
    ) {
      return new AsyncResource(type ?? (callback.name || "bound-anonymous-fn")).bind(
        callback,
        thisArg,
      );
    }
  }
  return markNodeBuiltinCapability(AsyncResource, {
    status: "conditional",
    evidence:
      "AsyncResource preserves native bind/runInAsyncScope context propagation. Numeric IDs, destroy notifications and lifecycle options throw ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED.",
  });
}
