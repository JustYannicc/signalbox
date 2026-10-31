import { readCommandObservation } from "./commandObservation.ts";
/** Observation at the real WorkerLoader.get boundary. No worker is acquired here. */
export type ObserverRoute = { readonly method: string; readonly path: string };
export type ObservedRole = "facet" | "command";
export interface ObserverCallPin {
  readonly route: ObserverRoute;
  /** The RPC input's requestId or invocationId, or "*" for a no-input method. */
  readonly callId: string;
}
export interface ObserverLoaderPin {
  readonly loaderId: string;
  readonly role: ObservedRole;
  readonly entrypoint: string;
  readonly identity: string;
  readonly tag: string;
  /** Method names map to exact call IDs and routes supplied by the build owner. */
  readonly calls: Readonly<Record<string, readonly ObserverCallPin[]>>;
}
export interface ObserverLoaderOptions {
  readonly runId: string;
  readonly actualTailFetcher: Fetcher;
  readonly pins: readonly ObserverLoaderPin[];
  readonly recordMapping: (record: {
    readonly loaderId: string;
    readonly identity: string;
    readonly role: ObservedRole;
    readonly entrypoint: string;
    readonly originalMainModule: string;
    readonly originalSourceModule: string;
  }) => void | Promise<void>;
}

function checkPin(pin: ObserverLoaderPin): void {
  if (!pin.loaderId || !pin.identity || !pin.tag || !pin.entrypoint)
    throw new TypeError("Observer loader pin is incomplete");
  if (pin.role === "facet" && !["CodexFacet", "ClaudeFacet"].includes(pin.entrypoint))
    throw new TypeError("Facet observer must wrap an actual product facet");
  if (pin.role === "command" && !/^(?:default|[A-Za-z_$][\w$]*)$/.test(pin.entrypoint))
    throw new TypeError("Command observer must wrap default entrypoint");
  const methods =
    pin.role === "facet"
      ? [
          "identity",
          "isolateNonceProbe",
          "startFresh",
          "prepareInert",
          "run",
          "loadedPreparedRelease",
          "dispose",
          "observerCalibration",
        ]
      : ["run"];
  if (Object.keys(pin.calls).some((name) => !methods.includes(name)))
    throw new TypeError("Unknown observed method");
  for (const [method, calls] of Object.entries(pin.calls)) {
    if (!calls.length) throw new TypeError("Observed method has no route pins: " + method);
    const ids = new Set<string>();
    for (const call of calls) {
      if (!call.callId || !call.route?.method || !call.route.path?.startsWith("/"))
        throw new TypeError("Observer call pin is incomplete");
      if (ids.has(call.callId))
        throw new TypeError("Duplicate observer call ID: " + method + ":" + call.callId);
      ids.add(call.callId);
    }
  }
}

function sourceOf(module: WorkerLoaderWorkerCode["modules"][string]): string {
  if (typeof module === "string") return module;
  if (module && "js" in module && typeof module.js === "string") return module.js;
  throw new TypeError("Observed Worker main module must be JavaScript");
}

function siblingName(main: string, modules: WorkerLoaderWorkerCode["modules"]): string {
  const slash = main.lastIndexOf("/");
  const dir = slash < 0 ? "" : main.slice(0, slash + 1);
  let name = `${dir}__observer_original_${main.slice(slash + 1)}`;
  while (Object.hasOwn(modules, name)) name = `${dir}_${name.slice(dir.length)}`;
  return name;
}

function shim(main: string, original: string, runId: string, pin: ObserverLoaderPin): string {
  const relative = `./${original.slice(main.lastIndexOf("/") + 1)}`;
  const config = JSON.stringify({
    runId,
    identity: pin.identity,
    loaderId: pin.loaderId,
    entrypoint: pin.entrypoint,
    tag: pin.tag,
    producerClass: "dynamic-worker",
    calls: pin.calls,
  });
  const header =
    pin.entrypoint === "default"
      ? `import Actual from ${JSON.stringify(relative)};`
      : `import { ${pin.entrypoint} as Actual } from ${JSON.stringify(relative)};`;
  const importLine =
    pin.role === "facet"
      ? `import { ${pin.entrypoint} as Actual } from ${JSON.stringify(relative)};`
      : header;
  const methods =
    pin.role === "facet"
      ? `identity(...args) { return this.__observeSync("identity", args, () => super.identity(...args)); }
  isolateNonceProbe(...args) { return this.__observeSync("isolateNonceProbe", args, () => ({ facetNonce: this.facetNonce, loaderId: pin.loaderId })); }
  async startFresh(...args) { return this.__observe("startFresh", args, () => super.startFresh(...args)); }
  async prepareInert(...args) { return this.__observe("prepareInert", args, () => super.prepareInert(...args)); }
  async run(...args) { return this.__observe("run", args, () => super.run(...args)); }
  async loadedPreparedRelease(...args) { return this.__observe("loadedPreparedRelease", args, () => super.loadedPreparedRelease(...args)); }
  async dispose(...args) { return this.__observe("dispose", args, () => super.dispose(...args)); }
  async observerCalibration(...args) { return this.__observe("observerCalibration", args, () => super.observerCalibration(...args)); }`
      : `async run(...args) { return this.__observe("run", args, () => super.run(...args)); }`;
  const exportLine =
    pin.role === "facet"
      ? `export { Observed as ${pin.entrypoint} };`
      : pin.entrypoint === "default"
        ? "export default Observed;"
        : `export { Observed as ${pin.entrypoint} };`;
  return `${importLine}
// Native personality replaces global console when the guest starts.
const hostLog = console.log.bind(console);
const pin = ${config};
${pin.role === "facet" ? "let isolateNonce;\nfunction getIsolateNonce() { return isolateNonce ??= crypto.randomUUID(); }" : ""}
let runtimeWorkerId;
function workerIdentity() { return runtimeWorkerId ??= crypto.randomUUID(); }
class Observed extends Actual {
  __response(method, result) {
    ${
      pin.role === "facet"
        ? `if (result !== undefined && (result === null || typeof result !== "object" || Array.isArray(result))) throw new TypeError("Facet RPC returned an unsupported nonce response shape");
    return method === "identity" || method === "isolateNonceProbe" || method === "observerCalibration" ? { ...result, isolateNonce: getIsolateNonce() } : result;`
        : "return result;"
    }
  }
  __call(method, args) {
    ${
      pin.role === "command"
        ? `const observed = (${readCommandObservation.toString()})(args[0]);
    args[0] = observed.command;
    return observed.call;`
        : `const input = args[0];
    const callId = input && (input.requestId ?? input.invocationId) || "*";
    const choices = pin.calls[method] || [];
    const selected = choices.find(item => item.callId === callId) ?? choices.find(item => item.callId === "*");
    if (!selected) throw new Error("Observer has no exact route pin for " + method + ":" + callId);
    const invocationId = String(callId === "*" ? crypto.randomUUID() : callId);
    return { route: selected.route, invocationId };`
    }
  }
  __emit(method, call, milestone) {
    hostLog(JSON.stringify({ producerEvent: { schema: "sb1070/producer/v1", runId: pin.runId,
      identity: pin.identity, producerClass: pin.producerClass, workerId: workerIdentity(),
      entrypoint: pin.entrypoint, tag: pin.tag, route: call.route, milestone,
      invocationId: call.invocationId, ${pin.role === "facet" ? "isolateNonce: getIsolateNonce()," : ""} } }));
    if (milestone === "entered") hostLog(JSON.stringify({ observerIdentity: {
      loaderId: pin.loaderId, workerId: workerIdentity(), identity: pin.identity,
      facetNonce: typeof this.facetNonce === "string" ? this.facetNonce : null,
      invocationId: call.invocationId, ${pin.role === "facet" ? "isolateNonce: getIsolateNonce()," : ""} } }));
  }
  __observeSync(method, args, invoke) {
    const call = this.__call(method, args);
    this.__emit(method, call, "entered");
    try { return this.__response(method, invoke()); }
    catch (error) { hostLog(JSON.stringify({ observerFailure: { identity: pin.identity,
      invocationId: call.invocationId, name: String(error?.name ?? "Error") } })); throw error; }
    finally { this.__emit(method, call, "terminal"); }
  }
  async __observe(method, args, invoke) {
    const call = this.__call(method, args);
    this.__emit(method, call, "entered");
    try { return this.__response(method, await invoke()); }
    catch (error) { hostLog(JSON.stringify({ observerFailure: { identity: pin.identity,
      invocationId: call.invocationId, name: String(error?.name ?? "Error") } })); throw error; }
    finally { this.__emit(method, call, "terminal"); }
  }
  ${methods}
}
${exportLine}
`;
}

/** Retains every original module byte under its original name except the main source, which moves to a sibling name unchanged. */
export function observeWorkerCode(
  code: WorkerLoaderWorkerCode,
  runId: string,
  pin: ObserverLoaderPin,
  actualTailFetcher: Fetcher,
): { code: WorkerLoaderWorkerCode; originalSourceModule: string } {
  checkPin(pin);
  if (!runId || !actualTailFetcher)
    throw new TypeError("Observer needs run ID and actual tail fetcher");
  const main = code.mainModule;
  const original = code.modules[main];
  if (!main || original === undefined) throw new TypeError("Worker main module is absent");
  sourceOf(original);
  const originalSourceModule = siblingName(main, code.modules);
  const modules = {
    ...code.modules,
    [originalSourceModule]: typeof original === "string" ? { js: original } : original,
    [main]: { js: shim(main, originalSourceModule, runId, pin) },
  };
  return {
    code: { ...code, modules, tails: [...(code.tails ?? []), actualTailFetcher] },
    originalSourceModule,
  };
}

/** Pass this as the injected platform WorkerLoader. Actual loader.get and all returned stubs remain platform-owned. */
export function createObservedWorkerLoader(
  loader: WorkerLoader,
  options: ObserverLoaderOptions,
): WorkerLoader {
  const pins = new Map(
    options.pins.map((pin) => {
      checkPin(pin);
      return [pin.loaderId, pin] as const;
    }),
  );
  if (pins.size !== options.pins.length) throw new TypeError("Observer loader IDs are duplicated");
  return {
    get(name, getCode) {
      if (name === null) throw new TypeError("Observed WorkerLoader.get needs a stable loader ID");
      const pin = pins.get(name);
      if (!pin) throw new Error("Unpinned WorkerLoader.get: " + name);
      return loader.get(name, async () => {
        const originalCode = await getCode();
        const observed = observeWorkerCode(
          originalCode,
          options.runId,
          pin,
          options.actualTailFetcher,
        );
        await options.recordMapping({
          loaderId: name,
          identity: pin.identity,
          role: pin.role,
          entrypoint: pin.entrypoint,
          originalMainModule: originalCode.mainModule,
          originalSourceModule: observed.originalSourceModule,
        });
        return observed.code;
      });
    },
    load: (code) => loader.load(code),
  };
}

/** Add these entries to the root's outer-worker pins. Calibration-only pins stay separate. */
export function expectedProducerEventsFromLoaderPins(pins: readonly ObserverLoaderPin[]) {
  return pins.map((pin) => {
    checkPin(pin);
    const routes = Object.values(pin.calls).flatMap((calls) => calls.map((call) => call.route));
    const unique = [
      ...new Map(routes.map((route) => [`${route.method} ${route.path}`, route])).values(),
    ];
    return {
      identity: pin.identity,
      producerClass: "dynamic-worker" as const,
      workerIdPolicy: "emitted" as const,
      entrypoint: pin.entrypoint,
      tag: pin.tag,
      routes: unique,
      milestones: ["entered", "terminal"] as const,
    };
  });
}
