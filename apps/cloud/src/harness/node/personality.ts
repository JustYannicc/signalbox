import { createHarnessModelTransport } from "./modelTransport.ts";
import { installNodePersonality } from "../../isolate/NodeBootstrap.ts";
import { RELEASE_MODULE_OMITTED_SYMBOL } from "../HarnessProcessLifetime.ts";
import type { NodeHarnessProcessInput } from "./types.ts";
import type { createHarnessRuntime } from "./runtime.ts";

let launched = false;
let active: object | undefined;

export function reserveHarnessRealm() {
  if (active !== undefined || Object.hasOwn(globalThis, Symbol.for("signalbox.nodeBridge.v1"))) {
    throw new Error("A live Node personality already owns this realm");
  }
  // Imported release modules and builtin facades keep their first process's objects.
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
  const reporter: NonNullable<NodeHarnessProcessInput["reportReleaseModuleOmitted"]> =
    input.reportReleaseModuleOmitted ?? (() => undefined);
  const previous = new Map<PropertyKey, PropertyDescriptor | undefined>(
    ["fetch", "console"].map(
      (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
    ),
  );
  const previousReporter = Object.getOwnPropertyDescriptor(
    globalThis,
    RELEASE_MODULE_OMITTED_SYMBOL,
  );
  const pendingReports = new Set<Promise<void>>();
  const reportErrors: unknown[] = [];
  let globalsRestored = false;
  const report = (
    event: Parameters<typeof reporter>[0],
    failure: Parameters<typeof reporter>[1],
  ) => {
    const pending = reporter(event, failure);
    if (pending !== undefined) {
      let tracked: Promise<void>;
      tracked = Promise.resolve(pending).then(
        () => {
          pendingReports.delete(tracked);
        },
        (error) => {
          reportErrors.push(error);
          pendingReports.delete(tracked);
        },
      );
      pendingReports.add(tracked);
    }
  };
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
    // Imported modules and queued callbacks outlive process.exited. This realm cannot
    // launch again, so its reporter stays installed until the Worker destroys the realm.
    Object.defineProperty(globalThis, RELEASE_MODULE_OMITTED_SYMBOL, {
      value: report,
      configurable: true,
      writable: false,
      enumerable: false,
    });
  } catch (error) {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    if (previousReporter)
      Object.defineProperty(globalThis, RELEASE_MODULE_OMITTED_SYMBOL, previousReporter);
    else Reflect.deleteProperty(globalThis, RELEASE_MODULE_OMITTED_SYMBOL);
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
    async drainReports() {
      while (pendingReports.size > 0) {
        await Promise.all(Array.from(pendingReports));
      }
      const failures = reportErrors.splice(0);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Release omission reports failed");
    },
    restoreGlobals() {
      if (globalsRestored) return;
      if (Object.getOwnPropertyDescriptor(globalThis, "fetch")?.value !== modelFetch) {
        throw new Error("Node harness fetch ownership changed");
      }
      if (Object.getOwnPropertyDescriptor(globalThis, "console")?.value !== runtime.console) {
        throw new Error("Node harness console ownership changed");
      }
      if (
        Object.getOwnPropertyDescriptor(globalThis, RELEASE_MODULE_OMITTED_SYMBOL)?.value !== report
      ) {
        throw new Error("Node harness release reporter ownership changed");
      }
      personality.restore();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      globalsRestored = true;
    },
  };
}
