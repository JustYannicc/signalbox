// @effect-diagnostics nodeBuiltinImport:off - Wrangler needs a filesystem entry point.
import * as NodeURL from "node:url";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

const harness = createTestHarness({
  workers: [
    {
      config: {
        name: "node-computer-output-cancellation-test",
        main: NodeURL.fileURLToPath(
          new URL("./NodeComputerOutputCancellation.fixture.ts", import.meta.url),
        ),
        compatibility_date: "2026-10-01",
        compatibility_flags: ["nodejs_compat"],
        durable_objects: {
          bindings: [{ name: "OUTPUTS", class_name: "NodeComputerOutputCancellation" }],
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["NodeComputerOutputCancellation"] }],
      },
    },
  ],
});

beforeAll(() => harness.listen(), 60_000);
afterAll(() => harness.close());

it.each(["context-abort", "sigterm"] as const)(
  "closes %s output readers without unhandled cancellation errors or leaked resources",
  async (mode) => {
    const started = await harness.fetch(`http://proof/${mode}`, { method: "POST" });
    expect(started.status, await started.text()).toBe(200);

    // The next request observes rejections reported after the command's completion microtasks.
    const response = await harness.fetch(`http://proof/${mode}`);
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      command: "/bin/rg",
      pendingReads: { source: 2, destination: 3 },
      disposed: true,
      cleanup: {
        sourceDescriptors: 0,
        destinationDescriptors: 0,
        sourceWakeTokens: 0,
        destinationWakeTokens: 0,
        sourceProcesses: 0,
        destinationProcesses: 0,
        baseDescriptorsBeforeDispose: 1,
        baseDescriptorsAfterDispose: 0,
      },
    });
    if (mode === "sigterm") {
      expect(JSON.parse(text)).toMatchObject({ close: { exitCode: null, signal: "SIGTERM" } });
    }
    expect(JSON.parse(text)).toMatchObject({ unhandled: [] });
  },
);
