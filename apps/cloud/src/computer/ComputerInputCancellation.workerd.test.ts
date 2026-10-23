// @effect-diagnostics nodeBuiltinImport:off - Wrangler needs a filesystem entry point.
import * as NodeURL from "node:url";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

const harness = createTestHarness({
  workers: [
    {
      config: {
        name: "computer-input-cancellation-test",
        main: NodeURL.fileURLToPath(
          new URL("./tests/inputCancellationWorkerd.fixture.ts", import.meta.url),
        ),
        compatibility_date: "2026-10-01",
        compatibility_flags: ["nodejs_compat"],
        durable_objects: { bindings: [{ name: "INPUTS", class_name: "InputCancellation" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: ["InputCancellation"] }],
      },
    },
  ],
});

beforeAll(() => harness.listen(), 60_000);
afterAll(() => harness.close());

it.each(["forwarded", "node"])(
  "finishes %s commands with blocked stdin and no unhandled cancellation",
  async (kind) => {
    const started = await harness.fetch(`http://proof/${kind}`, { method: "POST" });
    expect(started.status, await started.text()).toBe(200);
    // The next request observes rejections reported after the command's completion microtasks.
    const response = await harness.fetch(`http://proof/${kind}`);
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(JSON.parse(text)).toEqual({
      enteredReadPoll: true,
      exitCode: 7,
      signal: 0,
      disposed: true,
      borrowedInputOpen: true,
      wakes: 0,
      unhandled: [],
    });
  },
);
