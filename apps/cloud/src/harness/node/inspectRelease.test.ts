// @effect-diagnostics nodeBuiltinImport:off - Prepared module evaluation stays in a disposable Node realm.
import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";
import { inspectNodeHarnessRelease } from "../InspectNodeHarnessRelease.ts";
import { fixture } from "./tests/fixture.ts";

const releaseSource = `
const require = globalThis[Symbol.for("signalbox.nodeBridge.v1")].require("node:module").createRequire("/signalbox/claude.js");
export const cwd = require("node:process").cwd();
export function launch() { throw new Error("Inspection must not launch the prepared CLI"); }
`;

it("imports the unchanged release only after the real Node bootstrap installed its bridge", async () => {
  const f = fixture();
  const context = NodeVM.createContext({ Symbol });
  const namespace = () => {
    const module = new NodeVM.SourceTextModule(releaseSource, { context });
    return module
      .link(() => {
        throw new Error("No static imports expected");
      })
      .then(async () => {
        await module.evaluate();
        return module.namespace;
      });
  };
  await expect(namespace()).rejects.toThrow("require");
  const packageOrder: string[] = [];
  try {
    const result = await inspectNodeHarnessRelease(
      {
        ...f.input,
        loadPackages: async (bridge) => {
          expect(Reflect.get(globalThis, Symbol.for("signalbox.nodeBridge.v1"))).toBe(bridge);
          packageOrder.push("packages");
          Reflect.set(context, Symbol.for("signalbox.nodeBridge.v1"), bridge);
          return {};
        },
        loadRelease: async () => {
          packageOrder.push("release");
          return await namespace();
        },
      },
      async (release, bridge) => {
        expect(Reflect.get(globalThis, Symbol.for("signalbox.nodeBridge.v1"))).toBe(bridge);
        return { cwd: Reflect.get(release, "cwd"), order: [...packageOrder] };
      },
    );
    expect(result).toEqual({ cwd: "/work", order: ["packages", "release"] });
    expect(Object.hasOwn(globalThis, Symbol.for("signalbox.nodeBridge.v1"))).toBe(false);
  } finally {
    await f.close();
  }
});
