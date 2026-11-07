import { RpcTarget } from "cloudflare:workers";
import { parse } from "acorn";
import type {
  CodeModeCellCompletion,
  CodeModeCellEvents,
  CodeModeCellInvocation,
  CodeModeCellLoaderPort,
  Json,
  CodeModeWorkerEvents,
} from "../Types.ts";

export interface CodeModeWorkerPolicy {
  /** Chosen by the loader service owner. No request field can override this. */
  readonly cpuMs: number;
}

class CellEvents extends RpcTarget implements CodeModeWorkerEvents {
  readonly #events: CodeModeCellEvents;
  stoppedRequested = false;
  callbacksClosed = false;
  readonly #deferStopped: boolean;
  abortRequested: { error: string | null } | undefined;
  constructor(events: CodeModeCellEvents, deferStopped = false) {
    super();
    this.#events = events;
    this.#deferStopped = deferStopped;
  }
  started() {
    return this.#events.started();
  }
  emit(event: Parameters<CodeModeCellEvents["emit"]>[0]) {
    return this.#events.emit(event);
  }
  invoke(index: number, input: Json | undefined, id: string) {
    return this.#events.invoke(index, input, id);
  }
  notify(text: string) {
    return this.#events.notify(text);
  }
  cancelled() {
    return this.#events.cancelled();
  }
  closeCallbacks() {
    this.callbacksClosed = true;
    return this.#events.closeCallbacks();
  }
  stopped() {
    if (!this.#deferStopped) return this.#events.stopped();
    this.stoppedRequested = true;
    return Promise.resolve();
  }
  aborting(error: string | null) {
    this.abortRequested = { error };
    return Promise.resolve();
  }
}

interface CellEntrypoint {
  run(input: CodeModeCellInvocation, events: RpcTarget): Promise<CodeModeCellCompletion>;
}

export function createCodeModeWorkerLoader(options: {
  readonly loader: WorkerLoader;
  readonly policy: CodeModeWorkerPolicy;
}): CodeModeCellLoaderPort {
  const cpuMs = options.policy.cpuMs;
  if (!Number.isSafeInteger(cpuMs) || cpuMs <= 0)
    throw new RangeError("CodeMode cpuMs must be a positive safe integer");
  return {
    async run(input, events) {
      try {
        validateSource(input.request.source);
        if (
          Object.hasOwn(input.code.modules, "cell.js") ||
          Object.hasOwn(input.code.modules, "__code_mode_evaluation.js")
        )
          throw new Error("CodeMode bootstrap must reserve the cell evaluation modules");
      } catch (error) {
        try {
          await events.closeCallbacks();
        } finally {
          await events.stopped();
        }
        throw error;
      }
      let worker: WorkerStub | undefined;
      let entrypoint: CellEntrypoint | undefined;
      const bridge = new CellEvents(events, true);
      let started = false;
      let completion: CodeModeCellCompletion | undefined;
      let failure: { cause: unknown } | undefined;
      const disposalFailures: unknown[] = [];
      try {
        worker = options.loader.get(null, () => ({
          compatibilityDate: "2026-10-19",
          // Legacy module loading rejects top-level awaits before their request-owned effects finish.
          compatibilityFlags: ["new_module_registry"],
          // The cell gets a bare V8-like environment, without Node compatibility or network access.
          globalOutbound: null,
          limits: { cpuMs },
          mainModule: input.code.mainModule,
          modules: {
            ...input.code.modules,
            "cell.js": { js: input.request.source },
            // Importing the guest namespace directly would assimilate an exported then function.
            "__code_mode_evaluation.js": { js: 'import "./cell.js";\n' },
          },
        }));
        entrypoint = worker.getEntrypoint() as unknown as CellEntrypoint;
        started = true;
        try {
          completion = await entrypoint.run(input, bridge);
        } catch (cause) {
          if (bridge.abortRequested === undefined) throw cause;
          if (bridge.abortRequested.error !== null)
            throw new Error(bridge.abortRequested.error, { cause });
          completion = { terminated: true, error: null, writes: {} };
        }
      } catch (cause) {
        failure = { cause };
      } finally {
        // Releasing handles is insufficient to stop suspended ESM; aborting acknowledges only
        // after abortIsolate has rejected the child RPC and torn down its I/O context.
        for (const stub of [entrypoint, worker]) {
          if (stub === undefined) continue;
          try {
            const dispose = Reflect.get(stub, Symbol.dispose);
            if (typeof dispose === "function") dispose.call(stub);
          } catch (cause) {
            disposalFailures.push(cause);
          }
        }
        try {
          if (!started || bridge.stoppedRequested || bridge.abortRequested !== undefined) {
            try {
              if (!bridge.callbacksClosed) await events.closeCallbacks();
            } finally {
              await events.stopped();
            }
          }
        } catch (cause) {
          disposalFailures.push(cause);
        }
      }
      if (disposalFailures.length) {
        if (failure !== undefined) disposalFailures.unshift(failure.cause);
        throw new AggregateError(disposalFailures, "CodeMode worker disposal failed");
      }
      if (failure !== undefined) throw failure.cause;
      if (completion === undefined)
        throw new Error("CodeMode worker returned without a completion");
      return completion;
    },
  };
}

/** The static service owns its WorkerLoader binding and fixed policy. */
export function createCodeModeServiceLoader(service: {
  readonly run: (
    input: CodeModeCellInvocation,
    events: CodeModeCellEvents & RpcTarget,
  ) => Promise<CodeModeCellCompletion>;
}): CodeModeCellLoaderPort {
  return { run: (input, events) => service.run(input, new CellEvents(events)) };
}

function validateSource(source: string) {
  const root = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) continue;
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    const node = value as Record<string, unknown>;
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ImportExpression" ||
      ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
        node.source != null)
    )
      throw new Error("CodeMode cells do not support imports");
    pending.push(...Object.values(node));
  }
}
