import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";
import { HarnessError } from "../../../../src/harness/Harness.ts";
import { HarnessRequestFacetError } from "../../../../src/harness/HarnessRequestFacet.ts";
import { errorRecord } from "./common.ts";

describe("qualification failure receipts", () => {
  it("retains nested object and Effect causes through the turn-start JSON boundary", () => {
    const native = Object.assign(
      new Error("Native MCP configuration failed", {
        cause: {
          name: "McpHandshakeError",
          message: "The fixture did not acknowledge initialization",
          code: "MCP_INITIALIZATION_TIMEOUT",
          stack: "McpHandshakeError: fixture initialization",
          cause: { code: "ETIMEDOUT", elapsedMs: 120_000 },
        },
      }),
      { code: "NATIVE_MCP_START" },
    );
    const wrapped = new HarnessRequestFacetError("Canonical Harness turn failed to start.", {
      cause: new HarnessError({
        operation: "turn",
        message: "Native MCP configuration or turn start failed.",
        cause: Cause.fail(native),
      }),
    });

    const receipt = JSON.stringify(errorRecord(wrapped));
    expect(receipt).not.toContain("[object Object]");
    expect(JSON.parse(receipt)).toMatchObject({
      message: "Canonical Harness turn failed to start.",
      stack: expect.any(String),
      cause: {
        name: "HarnessError",
        message: "Native MCP configuration or turn start failed.",
        cause: [
          {
            _tag: "Fail",
            error: {
              name: "Error",
              message: "Native MCP configuration failed",
              code: "NATIVE_MCP_START",
              stack: expect.any(String),
              cause: {
                name: "McpHandshakeError",
                message: "The fixture did not acknowledge initialization",
                code: "MCP_INITIALIZATION_TIMEOUT",
                stack: "McpHandshakeError: fixture initialization",
                cause: { code: "ETIMEDOUT", elapsedMs: 120_000 },
              },
            },
          },
        ],
      },
    });
  });

  it("keeps all AggregateError failures instead of only their shared message", () => {
    const failure = new AggregateError(
      [Object.assign(new Error("MCP handshake failed"), { code: "MCP_HANDSHAKE" })],
      "Native start and cleanup failed",
      { cause: { code: "CLEANUP_FAILED", cause: new Error("scope close failed") } },
    );

    expect(JSON.parse(JSON.stringify(errorRecord(failure)))).toMatchObject({
      name: "AggregateError",
      errors: [{ message: "MCP handshake failed", code: "MCP_HANDSHAKE" }],
      cause: { code: "CLEANUP_FAILED", cause: { message: "scope close failed" } },
    });
  });
});
