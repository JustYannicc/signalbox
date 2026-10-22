import { createHarnessModelTransport } from "./modelTransport.ts";
import { installNodePersonality } from "../../isolate/NodeBootstrap.ts";
import { RELEASE_CHUNK_OMITTED_SYMBOL } from "../ClaudeHostConfig.ts";
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
  const reporter = input.reportReleaseChunkOmitted ?? (() => undefined);
  const previous = new Map<PropertyKey, PropertyDescriptor | undefined>([
    ...["fetch", "console"].map(
      (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
    ),
    [
      RELEASE_CHUNK_OMITTED_SYMBOL,
      Object.getOwnPropertyDescriptor(globalThis, RELEASE_CHUNK_OMITTED_SYMBOL),
    ],
  ]);
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
    Object.defineProperty(globalThis, RELEASE_CHUNK_OMITTED_SYMBOL, {
      value: reporter,
      configurable: true,
      writable: false,
      enumerable: false,
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
    async drain() {
      const results = await Promise.allSettled([
        Promise.resolve().then(transport.drain),
        Promise.resolve().then(runtime.drainDns),
      ]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Node harness transport cleanup failed");
    },
    restore() {
      if (Object.getOwnPropertyDescriptor(globalThis, "fetch")?.value !== modelFetch) {
        throw new Error("Node harness fetch ownership changed");
      }
      if (Object.getOwnPropertyDescriptor(globalThis, "console")?.value !== runtime.console) {
        throw new Error("Node harness console ownership changed");
      }
      if (
        Object.getOwnPropertyDescriptor(globalThis, RELEASE_CHUNK_OMITTED_SYMBOL)?.value !==
        reporter
      ) {
        throw new Error("Node harness release reporter ownership changed");
      }
      personality.restore();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}
