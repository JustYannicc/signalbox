import * as NodeURL from "node:url";
import { build } from "esbuild";
import { expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

it("moves port leases and cyclic binary messages between distinct workerd isolates", async () => {
  const compiled = await build({
    entryPoints: [
      NodeURL.fileURLToPath(new URL("./workerPorts.child.fixture.ts", import.meta.url)),
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "esnext",
    external: ["cloudflare:workers", "node:*"],
    write: false,
  });
  const source = compiled.outputFiles[0]?.text;
  if (source === undefined) throw new Error("The child bundle is empty");
  const harness = createTestHarness({
    workers: [
      {
        config: {
          name: "1396-worker-ports-test",
          main: NodeURL.fileURLToPath(new URL("./workerPorts.root.fixture.ts", import.meta.url)),
          compatibility_date: "2026-10-19",
          compatibility_flags: ["nodejs_compat"],
          worker_loaders: [{ binding: "LOADER" }],
          vars: { CHILD_SOURCE: source },
        },
      },
    ],
  });
  try {
    await harness.listen();
    const response = await harness.fetch("http://proof/", { signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const roundTrip = {
      detached: true,
      bytes: [0, 1, 127, 128, 255],
      alias: true,
      cycle: true,
      map: true,
    };
    expect(JSON.parse(text)).toEqual({
      isolation: [11, 7, 3, 11],
      ordinary: roundTrip,
      afterCreatorExit: roundTrip,
      staleOwnerRejected: true,
      ports: 0,
    });
  } catch (cause) {
    const trace = await harness.fetch("http://proof/trace");
    throw new Error(`Workerd port proof failed at ${await trace.text()}`, { cause });
  } finally {
    await harness.close();
  }
}, 60_000);
