import { expect, it } from "vite-plus/test";
import {
  readRpcData,
  withRpcStub,
  rpcResourceSnapshot,
  detachRpcData,
  releaseRpcResult,
} from "./Resources.ts";

it("does not count releasing an already-awaited result as another RPC call", () => {
  let pins = 2;
  const calls = rpcResourceSnapshot().calls;
  const value = detachRpcData({
    value: 1,
    [Symbol.dispose]() {
      pins--;
    },
  });
  releaseRpcResult({
    [Symbol.dispose]() {
      pins--;
    },
  });
  expect(value).toEqual({ value: 1 });
  expect(pins).toBe(0);
  expect(rpcResourceSnapshot().calls).toBe(calls);
});

it("releases a result even when its capability cannot cross the data-only boundary", async () => {
  let pins = 1;
  const result = {
    nested: { capability() {} },
    [Symbol.dispose]() {
      pins--;
    },
  };
  await expect(readRpcData(Promise.resolve(result))).rejects.toThrow();
  expect(pins).toBe(0);
  expect(rpcResourceSnapshot().activeResults).toBe(0);
});

it("releases each lookup stub after result disposal on success and a failed RPC", async () => {
  const order: string[] = [];
  for (const fails of [false, true]) {
    const stub = {
      [Symbol.dispose]() {
        order.push("stub");
      },
      async read() {
        if (fails) throw new Error("RPC failed");
        return {
          value: 1,
          [Symbol.dispose]() {
            order.push("result");
          },
        };
      },
    };
    const pending = withRpcStub(stub, (owned) => readRpcData(owned.read()));
    if (fails) await expect(pending).rejects.toThrow("RPC failed");
    else expect(await pending).toEqual({ value: 1 });
  }
  expect(order).toEqual(["result", "stub", "stub"]);
  expect(rpcResourceSnapshot()).toMatchObject({
    activeResults: 0,
    activeCalls: 0,
    activeStubs: 0,
  });
});
