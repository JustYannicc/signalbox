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
            { name: "PROCESS_EXECUTION_SHARDS", class_name: "HarnessProcessExecutionShardObject" },
            { name: "PLACEMENT_STORES", class_name: "HarnessProcessPlacementStoreObject" },
            { name: "HARNESS_THREAD_SUPERVISOR", class_name: "ProcessPlacementSupervisor" },
          ],
        },
        migrations: [
          {
            tag: "v1",
            new_sqlite_classes: [
              "HarnessProcessExecutionShardObject",
              "HarnessProcessPlacementStoreObject",
              "ProcessPlacementSupervisor",
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
  it("routes 105 processes through four-process entrypoint requests and keyed facets", async () => {
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
            readonly facetKey: string;
            readonly incarnationNonce: string;
          } | null;
          readonly settlement?: {
            readonly value: {
              readonly moduleNonce: string;
              readonly constructorNonce: string;
              readonly loaderId: string;
              readonly facetKey: string;
              readonly requestContextId: string;
              readonly phases: readonly string[];
            };
          };
          readonly status: string;
          readonly error?: {
            readonly facetFailureAt?: string;
            readonly facetFailureCode?: string;
            readonly causeCode?: string;
          };
        }[];
      };
    };

    expect(result.result.processes).toHaveLength(105);
    expect(
      result.result.processes.every((process) => process.status === "settled"),
      JSON.stringify(result.result.processes.slice(0, 4)),
    ).toBe(true);
    expect(result.result.processes.every((process) => process.identity !== null)).toBe(true);
    expect(new Set(result.result.processes.map((process) => process.identity!.loaderId)).size).toBe(
      105,
    );
    expect(
      result.result.processes.every((process) => process.identity!.loaderId.length > 128),
    ).toBe(true);
    expect(
      result.result.processes.every(
        (process) => process.identity!.facetKey === process.identity!.loaderId,
      ),
    ).toBe(true);
    expect(
      new Set(result.result.processes.map((process) => process.identity!.incarnationNonce)).size,
    ).toBe(105);
    expect(
      new Set(result.result.processes.map((process) => process.settlement!.value.moduleNonce)).size,
    ).toBe(105);
    expect(
      new Set(result.result.processes.map((process) => process.settlement!.value.constructorNonce))
        .size,
    ).toBe(105);

    const perRequest = new Map<string, number>();
    for (const process of result.result.processes)
      perRequest.set(process.requestContextId, (perRequest.get(process.requestContextId) ?? 0) + 1);
    expect(perRequest.size).toBe(27);
    expect([...perRequest.values()].sort((left, right) => left - right)).toEqual([
      1,
      ...Array.from({ length: 26 }, () => 4),
    ]);

    for (const process of result.result.processes) {
      expect(process.settlement!.value.phases).toEqual([
        "identity",
        "prepare",
        "activate",
        "invoke",
      ]);
      expect(process.settlement!.value.loaderId).toBe(process.identity!.loaderId);
      expect(process.settlement!.value.facetKey).toBe(process.identity!.facetKey);
      expect(process.settlement!.value.requestContextId).toBe(process.requestContextId);
    }
    // Request group sizes prove routing only. They do not claim concurrent JavaScript execution.
  }, 120_000);

  it("rejects a duplicate runShard while the original owns its durable context", async () => {
    const response = await harness.fetch("/duplicate");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
      duplicateRejected: true,
      result: { processes: [{ status: "settled" }] },
    });
  }, 120_000);

  it("releases an empty unplaceable writer for a later explicit request", async () => {
    const response = await harness.fetch("/unplaceable");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
      firstResult: { processes: [{ status: "unplaceable", identity: null }] },
      retryResult: { processes: [{ status: "settled" }] },
    });
  }, 120_000);

  it("repairs retained state under the current claim without replaying invocation", async () => {
    const start = await harness.fetch("/recover/start");
    const startBody = await start.text();
    expect(start.status, startBody).toBe(200);
    expect(startBody).not.toContain("private-prompt-sentinel");
    expect(JSON.parse(startBody)).toMatchObject({
      result: { processes: [{ status: "recoverable", recoveryId: expect.any(String) }] },
    });

    const stale = await harness.fetch("/recover/stale");
    const staleBody = await stale.text();
    expect(stale.status, staleBody).toBe(200);
    expect(JSON.parse(staleBody)).toMatchObject({ staleRejected: true });

    const retry = await harness.fetch("/recover/retry");
    const retryBody = await retry.text();
    expect(retry.status, retryBody).toBe(200);
    const result = JSON.parse(retryBody) as {
      readonly result: { readonly processes: readonly { readonly status: string }[] };
    };
    expect(result.result.processes).toMatchObject([{ status: "recovered" }]);
  }, 120_000);

  it("transactionally fences delayed writer A mutations after writer B claims the shard", async () => {
    const response = await harness.fetch("/fence");
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
      duplicateRejected: true,
      staleReleaseRejected: true,
      oldWriterRejected: true,
      staleSaveRejected: true,
      staleRecoverySaveRejected: true,
      staleRecoveryRemoveRejected: true,
      stateUnchanged: true,
      recoveryUnchanged: true,
    });
  }, 120_000);
});
