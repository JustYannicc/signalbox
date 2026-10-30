import { expect, it } from "vite-plus/test";
import { createNodeRuntimeCompatibility } from "../NodeRuntimeCompatibility.ts";

it("keeps a caught main-realm failure after the guest changes its Error", async () => {
  const runtime = createNodeRuntimeCompatibility({ isMainThread: true });
  const module = runtime.module;
  const report: unknown = Reflect.get(module, "reportRuntimeFailure");
  if (typeof report !== "function") throw new Error("No runtime failure reporter");
  const error = Object.assign(new Error("unsupported schema"), {
    code: "AJV_SCHEMA_NOT_PRECOMPILED",
  });
  report(error);
  error.message = "guest cleared the error";
  report(new Error("later error"));
  await expect(runtime.failure).rejects.toMatchObject({
    message: "unsupported schema",
    code: "AJV_SCHEMA_NOT_PRECOMPILED",
  });
  await expect(runtime.assert()).rejects.toMatchObject({ message: "unsupported schema" });
});

it("refuses an unobserved native worker even when the guest catches construction failure", async () => {
  let started = false;
  const runtime = createNodeRuntimeCompatibility({
    Worker: function Worker() {
      started = true;
    },
  });
  const Worker: unknown = Reflect.get(runtime.module, "Worker");
  if (typeof Worker !== "function") throw new Error("No Worker constructor");
  expect(() => Reflect.construct(Worker, ["worker.js"])).toThrow(
    /failure reporting is unavailable/,
  );
  expect(started).toBe(false);
  await expect(runtime.assert()).rejects.toMatchObject({ code: "NODE_WORKER_RUNTIME_UNOBSERVED" });
});
