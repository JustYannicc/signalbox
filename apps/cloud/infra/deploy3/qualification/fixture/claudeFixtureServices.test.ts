import { expect, it } from "vite-plus/test";
import { ThreadId, ProviderSessionId } from "@t3tools/contracts";
import { productExecutor } from "../../../../src/harness/HarnessCProductCapabilities.ts";
import { createClaudeFixtureServices, requireFixtureMcpProbe } from "./claudeFixtureServices.ts";

const probe = {
  toolName: "mcp__executor__qualification_echo",
  input: { text: "local fixture probe" },
  expectedText: "local fixture probe",
};
function fixture() {
  const records: Array<{ kind: string; value: unknown }> = [];
  const services = createClaudeFixtureServices({
    runId: "qualification-run",
    threadIds: ["thread"],
    probe,
    record: async (kind, value) => {
      records.push({ kind, value });
    },
  });
  return { services, records };
}

it("uses normal fresh/restore/turn access and Executor MCP transport with the local server", async () => {
  const f = fixture();
  const identity = {
    threadId: ThreadId.make("thread"),
    providerSessionId: ProviderSessionId.make("session"),
  };
  const fresh = await f.services.resolveFreshAccess!({ ...identity, operationId: "create" });
  const restored = await f.services.resolveInitialAccess({
    ...identity,
    nativeSessionId: "native",
  });
  const turn = await f.services.resolveTurnAccess({
    threadId: identity.threadId,
    runId: "qualification-run/claude/baseline",
    requestId: "turn-1",
  });
  expect(fresh.connections).toEqual({ servers: [] });
  expect(restored.grant).toEqual(fresh.grant);
  const executor = productExecutor(f.services);
  const send = async (method: string, params?: unknown) => {
    const response = await executor.forward({
      target: { type: "executor" },
      grant: turn.grant,
      signal: new AbortController().signal,
      request: new Request("https://local-mcp.invalid/executor", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
      }),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  expect(await send("initialize", { protocolVersion: "2025-03-26" })).toMatchObject({
    result: { serverInfo: { name: "signalbox-qualification-fixture" } },
  });
  expect(await send("tools/list")).toMatchObject({
    result: { tools: [{ name: "qualification_echo" }] },
  });
  expect(
    await send("tools/call", { name: "qualification_echo", arguments: probe.input }),
  ).toMatchObject({
    result: { content: [{ type: "text", text: probe.expectedText }], isError: false },
  });
  expect(f.records.map((row) => row.kind)).toEqual([
    "claude-fixture-access",
    "claude-fixture-access",
    "claude-fixture-access",
    "claude-fixture-mcp",
    "claude-fixture-mcp",
    "claude-fixture-mcp",
  ]);
});

it("rejects another thread and a remote or mismatched MCP probe", async () => {
  const f = fixture();
  await expect(
    f.services.resolveTurnAccess({
      threadId: ThreadId.make("another-thread"),
      runId: "run",
      requestId: "request",
    }),
  ).rejects.toThrow("FIXTURE_THREAD_MISMATCH");
  expect(() =>
    requireFixtureMcpProbe({ ...probe, toolName: "mcp__executor__real_service" }),
  ).toThrow("LOCAL_ECHO_PROBE_REQUIRED");
  expect(() => requireFixtureMcpProbe({ ...probe, expectedText: "forged" })).toThrow(
    "LOCAL_ECHO_PROBE_REQUIRED",
  );
});
