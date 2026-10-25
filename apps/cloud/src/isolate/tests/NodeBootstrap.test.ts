// @effect-diagnostics nodeBuiltinImport:off - poisoned globals require a disposable Node process.
import { expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import { bootNodeRelease, installNodePersonality } from "../NodeBootstrap.ts";

it("installs scoped objects before loading the release and restores exact descriptors", async () => {
  const previousBun = Object.getOwnPropertyDescriptor(globalThis, "Bun");
  const previousProcess = Object.getOwnPropertyDescriptor(globalThis, "process");
  const bun = { main: "virtual.js" };
  const process = { cwd: () => "/work" };
  const loaded = await bootNodeRelease(
    { modules: { process }, globals: { Bun: bun } },
    async (bridge) => {
      expect(Reflect.get(globalThis, "Bun")).toBe(bun);
      expect(bridge.require("node:process")).toBe(process);
      return "loaded";
    },
  );
  expect(loaded.release).toBe("loaded");
  loaded.personality.restore();
  expect(Object.getOwnPropertyDescriptor(globalThis, "Bun")).toEqual(previousBun);
  expect(Object.getOwnPropertyDescriptor(globalThis, "process")).toEqual(previousProcess);
});

it("a failed import releases the owner and restores globals", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Bun");
  await expect(
    bootNodeRelease({ modules: { fs: {} }, globals: { Bun: {} } }, async () => {
      throw new Error("release failed");
    }),
  ).rejects.toThrow("release failed");
  expect(Object.getOwnPropertyDescriptor(globalThis, "Bun")).toEqual(previous);
  const next = installNodePersonality({ modules: { fs: {} } });
  next.restore();
});

it("the process global cannot disagree with the process builtin", () => {
  expect(() =>
    installNodePersonality({
      modules: { process: {} },
      globals: { process: {} },
    }),
  ).toThrow("The process global and builtin must share one host object");
  const next = installNodePersonality({ modules: { process: {} } });
  next.restore();
});

it("failed release initialization rolls back changed globals without masking its error", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Bun");
  const failure = new Error("release initialization failed");
  await expect(
    bootNodeRelease({ modules: {}, globals: { Bun: {} } }, async () => {
      Object.defineProperty(globalThis, "Bun", { value: {}, configurable: true });
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(Object.getOwnPropertyDescriptor(globalThis, "Bun")).toEqual(previous);
  const next = installNodePersonality({ modules: {} });
  next.restore();
});

it("reports an impossible rollback and still releases the registry", () => {
  const source = `import {bootNodeRelease, installNodePersonality} from ${JSON.stringify(new URL("../NodeBootstrap.ts", import.meta.url).href)};
delete globalThis.Bun;
const failure = new Error('release failed');
try {
  await bootNodeRelease({modules:{},globals:{Bun:{}}}, async () => {
    Object.defineProperty(globalThis,'Bun',{value:{},configurable:false});
    throw failure;
  });
  throw new Error('Expected a failed boot');
} catch(error) {
  if (!(error instanceof AggregateError) || error.errors[0] !== failure || !error.errors[1].message.includes('Cannot restore')) throw error;
}
const next = installNodePersonality({modules:{}});
next.restore();
const locked = installNodePersonality({modules:{}});
const key = Symbol.for('signalbox.nodeBridge.v1');
Object.defineProperty(globalThis,key,{configurable:false});
try {
  locked.restore();
  throw new Error('Expected a failed registry removal');
} catch(error) {
  if (error.code !== 'NODE_BRIDGE_OWNERSHIP_LOST') throw error;
}`;
  // A nonconfigurable global cannot be cleaned up inside the test worker.
  expect(() =>
    NodeChildProcess.execFileSync(process.execPath, ["--input-type=module", "--eval", source]),
  ).not.toThrow();
});
