import { expect, it, vi } from "vite-plus/test";
import { runHarnessProcessExecutionShard } from "./execution.ts";
import { openPlacementSession, PlacementCreationFailure } from "./executionLifecycle.ts";
import type { HarnessProcessExecutionEnvironment } from "./executionEnvironment.ts";
import { HarnessProcessPlacementError } from "./contracts.ts";

vi.mock("./executionLifecycle.ts", async (original) => ({
  ...(await original<typeof import("./executionLifecycle.ts")>()),
  openPlacementSession: vi.fn(),
}));

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
  vi.mocked(openPlacementSession).mockRejectedValueOnce(
    new PlacementCreationFailure(placement, []),
  );
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
    {} as HarnessProcessExecutionEnvironment,
    "shard-incarnation",
  );

  expect(result.processes[0]?.status).toBe("recoverable");
  expect(JSON.parse(JSON.stringify(result.processes[0]?.error))).toMatchObject({
    kind: "prepare-failed",
    message: "Existing process state needs repair.",
    cause: {
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
  });
});
