import { RpcTarget } from "cloudflare:workers";
import { parse } from "acorn";
import type {
  CodeModeCellCompletion,
  CodeModeCellEvents,
  CodeModeCellInvocation,
  CodeModeCellLoaderPort,
  Json,
} from "./types.ts";

export interface CodeModeWorkerPolicy {
  /** Chosen by the loader service owner. No request field can override this. */
  readonly cpuMs: number;
}

class CellEvents extends RpcTarget implements CodeModeCellEvents {
  readonly #events: CodeModeCellEvents;
  constructor(events: CodeModeCellEvents) {
    super();
    this.#events = events;
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
    return this.#events.closeCallbacks();
  }
  stopped() {
    return this.#events.stopped();
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
        await events.closeCallbacks();
        await events.stopped();
        throw error;
      }
      const worker = options.loader.get(null, () => ({
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
      const entrypoint = worker.getEntrypoint() as unknown as CellEntrypoint;
      return entrypoint.run(input, new CellEvents(events));
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
