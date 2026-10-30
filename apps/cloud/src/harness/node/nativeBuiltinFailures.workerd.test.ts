// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Exercise the default modules in local Workerd.
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

it("replaces Workerd placeholders and missing exports with declared named failures", async () => {
  const harness = createTestHarness({
    workers: [
      {
        config: {
          name: "node-builtin-named-failures",
          main: NodeURL.fileURLToPath(
            new URL("./tests/nativeBuiltinFailures.workerd.fixture.ts", import.meta.url),
          ),
          compatibility_date: "2026-10-01",
          compatibility_flags: ["nodejs_compat", "legacy_module_registry"],
        },
      },
    ],
  });
  try {
    await harness.listen();
    const response = await harness.fetch("http://proof/");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const result = JSON.parse(body);
    expect(result).toHaveLength(13);
    for (const row of result) {
      expect(row, row.builtin).toMatchObject({
        threw: true,
        code: "ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED",
        capability: {
          status: "unsupported",
          failure: { kind: "named-error", code: "ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED" },
        },
      });
    }
  } finally {
    await harness.close();
  }
});
