import { createHarnessModelTransport } from "./modelTransport.ts";
import { installNodePersonality } from "../../isolate/NodeBootstrap.ts";
import type { NodeHarnessProcessInput } from "./types.ts";
import type { createHarnessRuntime } from "./runtime.ts";

let launched = false;
let active: object | undefined;

export function reserveHarnessRealm() {
  if (active !== undefined || Object.hasOwn(globalThis, Symbol.for("signalbox.nodeBridge.v1"))) {
    throw new Error("A live Node personality already owns this realm");
  }
  // Imported release chunks and builtin facades keep their first process's objects.
  if (launched)
    throw new Error("This realm already launched a Node release. Use a separate Worker");
  const owner = {};
  active = owner;
  return {
    commit() {
      launched = true;
    },
    release() {
      if (active !== owner) throw new Error("Node harness realm ownership changed");
      active = undefined;
    },
  };
}

export function installHarnessPersonality(
  runtime: ReturnType<typeof createHarnessRuntime>,
  input: NodeHarnessProcessInput,
  signal: AbortSignal,
) {
  const personality = installNodePersonality({
    modules: runtime.modules,
    globals: { Bun: runtime.bun, process: runtime.process },
  });
  const previous = new Map(
    ["fetch", "console"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  const transport = createHarnessModelTransport(input.modelTransport, signal);
  const modelFetch = transport.fetch;
  try {
    Object.defineProperty(globalThis, "fetch", {
      value: modelFetch,
      configurable: true,
      writable: false,
      enumerable: previous.get("fetch")?.enumerable ?? true,
    });
    Object.defineProperty(globalThis, "console", {
      value: runtime.console,
      configurable: true,
      writable: false,
      enumerable: previous.get("console")?.enumerable ?? true,
    });
  } catch (error) {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    personality.restore();
    throw error;
  }
  return {
    bridge: personality.bridge,
    drain: transport.drain,
    restore() {
      if (Object.getOwnPropertyDescriptor(globalThis, "fetch")?.value !== modelFetch) {
        throw new Error("Node harness fetch ownership changed");
      }
      if (Object.getOwnPropertyDescriptor(globalThis, "console")?.value !== runtime.console) {
        throw new Error("Node harness console ownership changed");
      }
      personality.restore();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}
