// @effect-diagnostics globalTimers:off - the unit fixture observes native timers in the ESM context.
import * as NodeVM from "node:vm";
import * as NodeAsyncHooks from "node:async_hooks";
import type {
  CodeModeCellCode,
  CodeModeCellCompletion,
  CodeModeCellEvents,
  CodeModeCellInvocation,
} from "../../CodeModeHost.ts";

/** Unit-test evaluator only. This supplies no evidence about workerd or the native Codex engine. */
export function vmWorkerLoader() {
  const observations: {
    source: string;
    cpuMs: number | undefined;
    outbound: unknown;
    flags: string[] | undefined;
    context: NodeVM.Context;
    io: {
      operation: keyof CodeModeCellEvents | "setTimeout" | "clearTimeout";
      phase: "handler" | "module-evaluation" | "outside";
    }[];
  }[] = [];
  const loader = {
    get(_key: string | null, code: () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>) {
      return {
        getEntrypoint() {
          return {
            async run(
              input: CodeModeCellInvocation,
              events: CodeModeCellEvents,
            ): Promise<CodeModeCellCompletion> {
              const prepared = await code();
              const phase = new NodeAsyncHooks.AsyncLocalStorage<"handler" | "module-evaluation">();
              const io: (typeof observations)[number]["io"] = [];
              const recordIo = (operation: (typeof io)[number]["operation"]) => {
                io.push({ operation, phase: phase.getStore() ?? "outside" });
              };
              const context = NodeVM.createContext({
                setTimeout: (callback: () => void, delay?: number) => {
                  recordIo("setTimeout");
                  return setTimeout(callback, delay);
                },
                clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
                  recordIo("clearTimeout");
                  clearTimeout(handle);
                },
                atob,
              });
              const cellModule = prepared.modules["cell.js"];
              const source = typeof cellModule === "string" ? cellModule : (cellModule?.js ?? "");
              observations.push({
                source,
                cpuMs: prepared.limits?.cpuMs,
                outbound: prepared.globalOutbound,
                flags: prepared.compatibilityFlags,
                context,
                io,
              });
              const modules = new Map<string, NodeVM.Module>();
              const resolve = async (name: string): Promise<NodeVM.Module> => {
                const found = modules.get(name);
                if (found !== undefined) return found;
                if (name === "cloudflare:workers") {
                  const bridge = new NodeVM.SyntheticModule(
                    ["WorkerEntrypoint"],
                    function () {
                      this.setExport("WorkerEntrypoint", Object);
                    },
                    { context, identifier: name },
                  );
                  modules.set(name, bridge);
                  await bridge.link(() => {
                    throw new Error("Unexpected bridge import");
                  });
                  return bridge;
                }
                const key = name.replace(/^\.\//, "");
                const item = prepared.modules[key];
                const js = typeof item === "string" ? item : item?.js;
                if (js === undefined) throw new Error(`Unknown test module ${key}`);
                const module = new NodeVM.SourceTextModule(js, {
                  context,
                  identifier: key,
                  importModuleDynamically: async (specifier) => {
                    const dynamic = await resolve(specifier);
                    // Guest continuations retain this phase; the handler's existing pump retains its own.
                    await phase.run("module-evaluation", () => dynamic.evaluate());
                    return dynamic;
                  },
                });
                modules.set(name, module);
                await module.link((specifier) => resolve(specifier));
                return module;
              };
              const main = await resolve(prepared.mainModule);
              await main.evaluate();
              const exports = main.namespace as unknown as {
                default: new () => {
                  run(
                    input: CodeModeCellInvocation,
                    events: CodeModeCellEvents,
                  ): Promise<CodeModeCellCompletion>;
                };
              };
              const observedEvents: CodeModeCellEvents = {
                emit: (event) => {
                  recordIo("emit");
                  return events.emit(event);
                },
                invoke: (index, argument, id) => {
                  recordIo("invoke");
                  return events.invoke(index, argument, id);
                },
                notify: (text) => {
                  recordIo("notify");
                  return events.notify(text);
                },
                cancelled: () => {
                  recordIo("cancelled");
                  return events.cancelled();
                },
                closeCallbacks: () => {
                  recordIo("closeCallbacks");
                  return events.closeCallbacks();
                },
                stopped: () => {
                  recordIo("stopped");
                  return events.stopped();
                },
              };
              return phase.run("handler", () => new exports.default().run(input, observedEvents));
            },
          };
        },
      };
    },
  } as unknown as WorkerLoader;
  return { loader, observations };
}

export function codeModeInvocation(code: CodeModeCellCode, source: string): CodeModeCellInvocation {
  return {
    code,
    storedValues: {},
    request: {
      source,
      tool_call_id: "call-1",
      enabled_tools: [],
      yield_time_ms: null,
      max_output_tokens: null,
    },
  };
}
