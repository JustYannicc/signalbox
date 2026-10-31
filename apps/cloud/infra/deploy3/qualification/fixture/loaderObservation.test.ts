// @effect-diagnostics nodeBuiltinImport:off - The regression executes only the observer shim in a controlled Node context.
import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";
import { observeWorkerCode } from "./loaderObservation.ts";

it("keeps exact public C results while retaining one module-init nonce across constructors", async () => {
  const logs: unknown[] = [];
  const code = observeWorkerCode(
    {
      compatibilityDate: "2026-10-19",
      mainModule: "facet.mjs",
      modules: { "facet.mjs": { js: "export class ClaudeFacet {}" } },
    },
    "test-run",
    {
      loaderId: "test-loader",
      role: "facet",
      entrypoint: "ClaudeFacet",
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
      return native;
    }
  }
  const context = NodeVM.createContext({
    Actual,
    crypto,
    console: { log: (text: string) => logs.push(JSON.parse(text)) },
  });
  const source = main.js
    .replace(/^import .*;\n/u, "")
    .replace(/export \{ Observed as ClaudeFacet \};/u, "globalThis.Observed = Observed;");
  NodeVM.runInContext(source, context);
  const Constructor = context.Observed as new () => {
    run(input: { requestId: string }): Promise<typeof result>;
    startFresh(): Promise<typeof native>;
    identity(): { facetNonce: string; isolateNonce: string };
  };
  const one = new Constructor();
  const two = new Constructor();
  expect(await one.run({ requestId: "request" })).toBe(result);
  expect(await one.startFresh()).toBe(native);
  expect(one.identity().isolateNonce).toBe(two.identity().isolateNonce);
  const events = logs.flatMap((row) =>
    row && typeof row === "object" && "producerEvent" in row ? [row.producerEvent] : [],
  ) as Array<{ isolateNonce: string }>;
  expect(events.length).toBeGreaterThan(0);
  expect(new Set(events.map((event) => event.isolateNonce)).size).toBe(1);
  expect(result).not.toHaveProperty("isolateNonce");
});
