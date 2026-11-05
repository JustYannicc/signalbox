import type * as NodeChildProcess from "node:child_process";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { captureRuntimeBuiltinInventory } from "./runtimeBuiltinInventory.ts";

const execFile = vi.hoisted(() => {
  const call =
    vi.fn<
      (
        file: string,
        args: readonly string[],
        options: NodeChildProcess.ExecFileOptionsWithStringEncoding,
      ) => Promise<{ stdout: string; stderr: string }>
    >();
  Object.defineProperty(call, Symbol.for("nodejs.util.promisify.custom"), {
    value: call,
    configurable: true,
  });
  return call;
});
vi.mock("node:child_process", () => ({ execFile }));

afterEach(() => {
  execFile.mockReset();
  vi.unstubAllEnvs();
});

it("passes native admission to the inventory child while stripping unrelated runtime configuration", async () => {
  vi.stubEnv("HOME", "/native-slot-fixture");
  vi.stubEnv("HEAVY_SLOT_ACTIVE", "1");
  vi.stubEnv("SIGNALBOX_WORKERD_ACTIVE", "/retired/ACTIVE.json");
  vi.stubEnv("SIGNALBOX_WORKERD_OWNER", "retired-owner");
  vi.stubEnv("SIGNALBOX_WORKERD_BATCH", "retired-batch");
  vi.stubEnv("NODE_OPTIONS", "--require=unrelated-preload.cjs");
  execFile.mockResolvedValue({
    stdout: JSON.stringify({
      modules: [],
      functions: [],
      profile: {
        systemIdentity: {},
        processIdentity: {},
        filesystem: { posixPolicy: true, setUmask: true },
        cpu: { execution: false, processAccounting: false },
      },
    }),
    stderr: "",
  });

  await captureRuntimeBuiltinInventory();

  expect(execFile).toHaveBeenCalledOnce();
  const options = execFile.mock.calls[0]![2];
  expect(options.env).toMatchObject({
    HOME: "/native-slot-fixture",
    HEAVY_SLOT_ACTIVE: "1",
    WRANGLER_SEND_METRICS: "false",
    CI: "1",
  });
  expect(options.env).not.toHaveProperty("NODE_OPTIONS");
  expect(options.env).not.toHaveProperty("SIGNALBOX_WORKERD_ACTIVE");
  expect(options.env).not.toHaveProperty("SIGNALBOX_WORKERD_OWNER");
  expect(options.env).not.toHaveProperty("SIGNALBOX_WORKERD_BATCH");
});
