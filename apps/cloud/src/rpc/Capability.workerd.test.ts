// @effect-diagnostics nodeBuiltinImport:off - Workerd exercises actual RPC argument ownership.
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

it.each(["target", "function"])(
  "retains a %s argument beyond its call and releases it at owner close",
  async (kind) => {
    const harness = createTestHarness({
      workers: [
        {
          config: {
            name: "rpc-argument-lifetime",
            main: NodeURL.fileURLToPath(
              new URL("./tests/Capability.workerd.fixture.ts", import.meta.url),
            ),
            compatibility_date: "2026-10-19",
            compatibility_flags: ["nodejs_compat"],
            durable_objects: {
              bindings: [
                { name: "RECEIVER", class_name: "Receiver" },
                { name: "AUTHORITY", class_name: "Authority" },
              ],
            },
            migrations: [{ tag: "v1", new_sqlite_classes: ["Receiver", "Authority"] }],
          },
        },
      ],
    });
    try {
      await harness.listen();
      const hold = await harness.fetch("http://proof/hold?kind=" + kind);
      const held = await hold.json();
      expect(hold.status, JSON.stringify(held)).toBe(200);
      const ping = await harness.fetch("http://proof/ping?kind=" + kind);
      const result = await ping.text();
      expect(ping.status, result).toBe(200);
      expect(JSON.parse(result)).toEqual({ value: "retained argument" });
      const close = await harness.fetch("http://proof/close?kind=" + kind);
      const closed = await close.json();
      expect(close.status, JSON.stringify(closed)).toBe(200);
      expect(closed).toMatchObject({
        resources: { activeStubs: 0, failedStubDisposals: 0 },
        disposed: 1,
      });
    } finally {
      await harness.close();
    }
  },
  60000,
);
