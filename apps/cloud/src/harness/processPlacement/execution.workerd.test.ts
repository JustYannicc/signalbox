// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - this proof invokes the public Worker entrypoint in local workerd.
import * as NodeURL from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createTestHarness } from "wrangler";

const harness = createTestHarness({
  workers: [
    {
      config: {
        name: "harness-process-placement-proof",
        main: NodeURL.fileURLToPath(new URL("./execution.workerd.fixture.ts", import.meta.url)),
        compatibility_date: "2026-10-19",
        compatibility_flags: ["nodejs_compat", "enable_ctx_exports"],
        vars: { RESIDENT_BYTE_LIMIT: "1048576" },
        worker_loaders: [{ binding: "LOADER" }],
        durable_objects: {
          bindings: [
            { name: "PLACEMENT_STORES", class_name: "HarnessProcessPlacementStoreObject" },
            { name: "PROCESS_LIFECYCLE", class_name: "ProcessPlacementLifecycle" },
            { name: "GATES", class_name: "ProcessPlacementGate" },
          ],
        },
        migrations: [
          {
            tag: "v1",
            new_sqlite_classes: [
              "HarnessProcessPlacementStoreObject",
              "ProcessPlacementLifecycle",
              "ProcessPlacementGate",
            ],
          },
        ],
      },
    },
  ],
});

beforeAll(() => harness.listen(), 60_000);
afterAll(() => harness.close());

describe("process execution Worker entrypoint", () => {
  it("routes 105 synthetic processes through independent four-process requests", async () => {
    const response = await harness.fetch("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 105 }),
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const result = JSON.parse(body) as {
      readonly result: {
        readonly processes: readonly {
          readonly processId: string;
          readonly requestContextId: string;
          readonly identity: {
            readonly loaderId: string;
            readonly incarnationNonce: string;
          } | null;
          readonly status: string;
        }[];
      };
      readonly gate: {
        readonly expected: number;
        readonly entered: number;
        readonly activeByContext: Record<string, number>;
        readonly peakByContext: Record<string, number>;
      };
    };

    expect(result.result.processes).toHaveLength(105);
    expect(result.result.processes.every((process) => process.status === "settled")).toBe(true);
    expect(result.result.processes.every((process) => process.identity !== null)).toBe(true);
    expect(new Set(result.result.processes.map((process) => process.identity!.loaderId)).size).toBe(
      105,
    );
    expect(
      new Set(result.result.processes.map((process) => process.identity!.incarnationNonce)).size,
    ).toBe(105);
    expect(result.gate).toMatchObject({ expected: 105, entered: 105 });
    expect(Object.values(result.gate.activeByContext).every((active) => active === 0)).toBe(true);

    const perRequest = new Map<string, number>();
    for (const process of result.result.processes)
      perRequest.set(process.requestContextId, (perRequest.get(process.requestContextId) ?? 0) + 1);
    expect(perRequest.size).toBe(27);
    expect([...perRequest.values()].sort((left, right) => left - right)).toEqual([
      1,
      ...Array.from({ length: 26 }, () => 4),
    ]);
    expect(Object.keys(result.gate.peakByContext).sort()).toEqual([...perRequest.keys()].sort());
    expect(Object.values(result.gate.peakByContext).every((peak) => peak <= 4)).toBe(true);
    expect(Object.values(result.gate.peakByContext).filter((peak) => peak === 4)).toHaveLength(26);
  }, 120_000);

  it("fences a concurrent retry and rejects a stale writer release", async () => {
    const response = await harness.fetch("/fence");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
      duplicateRejected: true,
      staleReleaseRejected: true,
      oldWriterRejected: true,
    });
  });
});
