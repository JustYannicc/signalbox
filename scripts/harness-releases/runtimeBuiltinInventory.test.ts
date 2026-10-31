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
  vi.stubEnv("SIGNALBOX_WORKERD_ACTIVE", "/guard-fixture/ACTIVE.json");
  vi.stubEnv("SIGNALBOX_WORKERD_OWNER", "test-owner");
  vi.stubEnv("SIGNALBOX_WORKERD_BATCH", "test-batch");
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
    SIGNALBOX_WORKERD_ACTIVE: "/guard-fixture/ACTIVE.json",
    SIGNALBOX_WORKERD_OWNER: "test-owner",
    SIGNALBOX_WORKERD_BATCH: "test-batch",
    WRANGLER_SEND_METRICS: "false",
    CI: "1",
  });
  expect(options.env).not.toHaveProperty("NODE_OPTIONS");
});
