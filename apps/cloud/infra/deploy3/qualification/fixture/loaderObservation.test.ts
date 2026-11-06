// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off - The regression executes the observer shim and WebCrypto in a controlled Node context.
import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";
import { observeWorkerCode } from "./loaderObservation.ts";

it("observes the import-only Claude calibration entrypoint without native dispatch", async () => {
  const invocationId = "claude-import-calibration-baseline-test";
  const route = { method: "POST", path: "/claude/baseline/calibration" };
  const logs: Array<{ producerEvent?: { route: typeof route; invocationId: string } }> = [];
  const observed = { incarnation: "inert-facet", invocationId, nativeStarted: false };
  class Actual {
    async observerCalibration(input: { invocationId: string }) {
      expect(input.invocationId).toBe(invocationId);
      return observed;
    }
    startFresh() {
      throw new Error("CLAUDE_INERT_FACET_NATIVE_DISPATCH_FORBIDDEN");
    }
  }
  const { code, originalSourceModule } = observeWorkerCode(
    {
      compatibilityDate: "2026-10-19",
      mainModule: "qualifier-claude-calibration-facet.mjs",
      modules: {
        "qualifier-claude-calibration-facet.mjs": {
          js: "export { ClaudeImportCalibrationFacet } from './qualifier-claude-implementation.mjs';",
        },
      },
    },
    "test-run",
    {
      loaderId: invocationId,
      role: "facet",
      entrypoint: "ClaudeImportCalibrationFacet",
      identity: "facet:claude:baseline:test",
      tag: "actual-claude-facet",
      calls: { observerCalibration: [{ callId: "*", route }] },
    },
    {} as Fetcher,
  );
  const main = code.modules[code.mainModule];
  if (typeof main !== "object" || !("js" in main)) throw new Error("Missing observation module");
  expect(code.modules[originalSourceModule]).toEqual({
    js: "export { ClaudeImportCalibrationFacet } from './qualifier-claude-implementation.mjs';",
  });
  const context = NodeVM.createContext({
    Actual,
    crypto,
    console: { log: (text: string) => logs.push(JSON.parse(text)) },
  });
  NodeVM.runInContext(
    main.js
      .replace(/^import .*;\n/u, "")
      .replace(/export \{ Observed as \w+ \};/u, "globalThis.Observed = Observed;"),
    context,
  );
  const Constructor = context.Observed as new () => {
    observerCalibration(input: { invocationId: string }): Promise<typeof observed>;
  };
  expect(await new Constructor().observerCalibration({ invocationId })).toMatchObject(observed);
  expect(logs.flatMap((row) => (row.producerEvent ? [row.producerEvent] : []))).toEqual([
    expect.objectContaining({ route, invocationId, milestone: "entered" }),
    expect.objectContaining({ route, invocationId, milestone: "terminal" }),
  ]);
});

it.each(["ClaudeFacet", "CodexFacet"] as const)(
  "keeps exact %s results and creates one isolate nonce only during an RPC",
  async (entrypoint) => {
    const logs: unknown[] = [];
    const guestLogs: string[] = [];
    const code = observeWorkerCode(
      {
        compatibilityDate: "2026-10-19",
        mainModule: "facet.mjs",
        modules: { "facet.mjs": { js: `export class ${entrypoint} {}` } },
      },
      "test-run",
      {
        loaderId: "test-loader",
        role: "facet",
        entrypoint,
        identity: "facet:claude:test",
        tag: "test",
        calls: {
          run: [
            {
              callId: "request",
              route: { method: "POST", path: "/claude/baseline/turn/1/dispatch" },
            },
          ],
          startFresh: [
            { callId: "*", route: { method: "POST", path: "/claude/baseline/turn/1/dispatch" } },
          ],
          identity: [{ callId: "*", route: { method: "POST", path: "/inspect" } }],
        },
      },
      {} as Fetcher,
    ).code;
    const main = code.modules[code.mainModule];
    if (typeof main !== "object" || !("js" in main)) throw new Error("Missing observation module");
    const result = { action: "committed", snapshot: { requests: { checkpoint: "exact-journal" } } };
    const native = { nativeSessionId: "native", checkpoint: { native: "artifact" } };
    class Actual {
      readonly facetNonce = "constructor-nonce";
      identity() {
        return { facetNonce: this.facetNonce };
      }
      async run(..._input: unknown[]) {
        return result;
      }
      async startFresh() {
        context.console = { log: (text: string) => guestLogs.push(text) };
        return native;
      }
    }
    let requestActive = false;
    let randomCalls = 0;
    const context = NodeVM.createContext({
      Actual,
      crypto: {
        randomUUID: () => {
          if (!requestActive)
            throw new Error("Disallowed operation called within global scope: crypto.randomUUID");
          randomCalls++;
          return crypto.randomUUID();
        },
      },
      console: { log: (text: string) => logs.push(JSON.parse(text)) },
    });
    const source = main.js
      .replace(/^import .*;\n/u, "")
      .replace(/export \{ Observed as \w+ \};/u, "globalThis.Observed = Observed;");
    NodeVM.runInContext(source, context);
    expect(randomCalls).toBe(0);
    const Constructor = context.Observed as new () => {
      run(input: { requestId: string }): Promise<typeof result>;
      startFresh(): Promise<typeof native>;
      identity(): { facetNonce: string; isolateNonce: string };
    };
    requestActive = true;
    const one = new Constructor();
    const two = new Constructor();
    expect(randomCalls).toBe(0);
    expect(await one.run({ requestId: "request" })).toBe(result);
    expect(randomCalls).toBe(2);
    expect(await one.startFresh()).toBe(native);
    expect(one.identity().isolateNonce).toBe(two.identity().isolateNonce);
    const events = logs.flatMap((row) =>
      row && typeof row === "object" && "producerEvent" in row ? [row.producerEvent] : [],
    ) as Array<{ isolateNonce: string }>;
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map((event) => event.isolateNonce)).size).toBe(1);
    expect(result).not.toHaveProperty("isolateNonce");
    expect(guestLogs).toEqual([]);
  },
);

it("observes the real CLI kernel facet without replacing its process RPCs", async () => {
  const route = { method: "POST", path: "/claude/kernel/inspect" };
  const logs: Array<{ producerEvent?: { route: typeof route; milestone: string } }> = [];
  const session = { sessionId: "retained-native-process" };
  const configuration = { threadId: "owner" };
  let closed = false;
  class Actual {
    readonly facetNonce = "actual-kernel-facet";
    configure(input: typeof configuration) {
      expect(input).toBe(configuration);
      return session;
    }
    open() {
      return session;
    }
    close() {
      closed = true;
    }
    identity() {
      return { facetNonce: this.facetNonce };
    }
  }
  const { code, originalSourceModule } = observeWorkerCode(
    {
      compatibilityDate: "2026-10-19",
      mainModule: "claude-kernel-entry.mjs",
      modules: {
        "claude-kernel-entry.mjs": {
          js: 'export { ClaudeKernelFacet } from "./qualifier-claude-kernel.mjs";',
        },
      },
    },
    "kernel-observation",
    {
      loaderId: "current-route:kernel",
      role: "facet",
      entrypoint: "ClaudeKernelFacet",
      identity: "kernel:claude:current-route",
      tag: "actual-claude-kernel",
      calls: {
        identity: [{ callId: "*", route }],
        isolateNonceProbe: [{ callId: "*", route }],
      },
    },
    {} as Fetcher,
  );
  const main = code.modules[code.mainModule];
  if (typeof main !== "object" || !("js" in main)) throw new Error("Missing observation module");
  expect(code.modules[originalSourceModule]).toEqual({
    js: 'export { ClaudeKernelFacet } from "./qualifier-claude-kernel.mjs";',
  });
  const context = NodeVM.createContext({
    Actual,
    crypto,
    console: { log: (text: string) => logs.push(JSON.parse(text)) },
  });
  NodeVM.runInContext(
    main.js
      .replace(/^import .*;\n/u, "")
      .replace(/export \{ Observed as \w+ \};/u, "globalThis.Observed = Observed;"),
    context,
  );
  const Constructor = context.Observed as new () => Actual & {
    identity(): { facetNonce: string; isolateNonce: string };
    isolateNonceProbe(): { facetNonce: string; isolateNonce: string };
  };
  const observed = new Constructor();
  expect(observed.configure(configuration)).toBe(session);
  expect(observed.open()).toBe(session);
  const identity = observed.identity();
  expect(identity.facetNonce).toBe("actual-kernel-facet");
  expect(observed.isolateNonceProbe()).toMatchObject(identity);
  observed.close();
  expect(closed).toBe(true);
  expect(logs.flatMap((row) => (row.producerEvent ? [row.producerEvent] : []))).toEqual([
    expect.objectContaining({ route, milestone: "entered" }),
    expect.objectContaining({ route, milestone: "terminal" }),
    expect.objectContaining({ route, milestone: "entered" }),
    expect.objectContaining({ route, milestone: "terminal" }),
  ]);
});
