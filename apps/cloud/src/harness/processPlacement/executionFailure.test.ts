import { expect, it, vi } from "vite-plus/test";
import {
  runHarnessProcessExecutionShard,
  HarnessProcessPlacementError,
  type HarnessProcessExecutionEnvironment,
} from "../HarnessProcessPlacement.ts";

it("returns the original coded startup cause when placement opening needs recovery", async () => {
  const native = Object.assign(
    new Error("Native MCP configuration failed", {
      cause: { code: "MCP_HANDSHAKE", cause: new Error("Fixture connection closed") },
    }),
    { code: "NATIVE_START" },
  );
  const placement = new HarnessProcessPlacementError(
    "prepare-failed",
    "The process could not open.",
    true,
    undefined,
    undefined,
    { cause: native },
  );
  const claimWriter = vi.fn(async () => undefined);
  const releaseWriter = vi.fn(async () => undefined);
  const environment = {
    RESIDENT_BYTE_LIMIT: "1",
    PLACEMENT_STORES: {
      getByName: () => ({
        claimWriter,
        releaseWriter,
        listRecovery: async () => [],
        load: async () => {
          throw placement;
        },
      }),
    },
    HARNESS_THREAD_SUPERVISOR: {
      getByName: () => ({
        execute: async () => ({
          snapshot: { ownerId: "owner", controlIncarnationId: "incarnation", controlEpoch: 1 },
        }),
      }),
    },
  } as unknown as HarnessProcessExecutionEnvironment;
  const input = {
    runId: "run",
    executionOperationId: "operation",
    shardOwner: "shard",
    controllerClaim: {
      ownerId: "owner",
      incarnationId: "incarnation",
      epoch: 1,
      controlKey: "control",
    },
    processes: [
      {
        processId: "process",
        codeId: "code",
        residentBytes: 1,
        nativeSessionId: "native",
        checkpointId: "checkpoint",
        manifestRevision: "manifest",
        operationId: "operation",
        priorFacetNonce: "prior",
        expectedFacetGeneration: 0,
        mainModule: "main.mjs",
        modules: { "main.mjs": "export default {}" },
        entrypoint: "Facet",
      },
    ],
  };
  const result = await runHarnessProcessExecutionShard(
    input,
    "request",
    {} as DurableObjectState,
    environment,
    "shard-incarnation",
  );

  expect(result.processes[0]?.status).toBe("recoverable");
  expect(claimWriter).toHaveBeenCalledOnce();
  expect(releaseWriter).not.toHaveBeenCalled();
  expect(JSON.parse(JSON.stringify(result.processes[0]?.error))).toMatchObject({
    kind: "recovery-unresolved",
    message: "Existing process state needs repair.",
    cause: {
      cause: {
        name: "ProcessSlotStorageError",
        message: "Process-slot storage load failed",
        cause: {
          name: "HarnessProcessPlacementError",
          message: "The process could not open.",
          cause: {
            message: native.message,
            code: "NATIVE_START",
            stack: native.stack,
            cause: {
              code: "MCP_HANDSHAKE",
              cause: { message: "Fixture connection closed", stack: expect.any(String) },
            },
          },
        },
      },
    },
  });
});
