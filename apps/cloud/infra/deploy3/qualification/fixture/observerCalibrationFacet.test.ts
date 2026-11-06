// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off - The regression executes the observed calibration facet and WebCrypto in a controlled Node context.
import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";
import {
  claudeObserverCalibrationCode,
  OBSERVER_CALIBRATION_FACET,
} from "./observerCalibrationFacet.ts";

function js(module: WorkerLoaderWorkerCode["modules"][string] | undefined) {
  if (typeof module !== "object" || !("js" in module) || typeof module.js !== "string")
    throw new Error("Expected a JavaScript module");
  return module.js;
}

it("calibrates the observer without loading any harness and ends on the loader ID", async () => {
  const loaderId = "claude-observer-calibration-test-run";
  const code = claudeObserverCalibrationCode("test-run", loaderId, {} as Fetcher);
  const originalName = Object.keys(code.modules).find((name) => name !== code.mainModule)!;
  const original = js(code.modules[originalName]);
  expect(Object.keys(code.modules)).toHaveLength(2);
  expect([...original.matchAll(/from "([^"]+)"/gu)].map((match) => match[1])).toEqual([
    "cloudflare:workers",
  ]);

  const logs: Array<{
    producerEvent?: { milestone: string; invocationId: string; route: { path: string } };
  }> = [];
  const context = NodeVM.createContext({
    DurableObject: Object,
    crypto,
    console: { log: (text: string) => logs.push(JSON.parse(text)) },
  });
  NodeVM.runInContext(
    `${original.replace(/^import .*;\n/u, "").replace(/^export /mu, "")}\nglobalThis.Actual = ${OBSERVER_CALIBRATION_FACET};`,
    context,
  );
  NodeVM.runInContext(
    js(code.modules[code.mainModule])
      .replace(/^import .*;\n/u, "")
      .replace(/export \{ Observed as \w+ \};/u, "globalThis.Observed = Observed;"),
    context,
  );
  const facet = new (context.Observed as new () => {
    identity(): { facetNonce: string };
    observerCalibration(input: { invocationId: string }): Promise<{
      incarnation: string;
      invocationId: string;
      nativeStarted: boolean;
    }>;
  })();
  const identity = facet.identity();
  const observed = await facet.observerCalibration({ invocationId: loaderId });
  expect(observed).toMatchObject({
    incarnation: identity.facetNonce,
    invocationId: loaderId,
    nativeStarted: false,
  });
  expect(
    logs.flatMap((row) =>
      row.producerEvent?.milestone === "terminal" ? [row.producerEvent.invocationId] : [],
    ),
  ).toContain(loaderId);
  expect(
    new Set(logs.flatMap((row) => (row.producerEvent ? [row.producerEvent.route.path] : []))),
  ).toEqual(new Set(["/claude/observer-calibration"]));
});
