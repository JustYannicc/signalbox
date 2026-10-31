// @effect-diagnostics nodeBuiltinImport:off - Run the Node personality in an isolated worker thread.
import * as NodeWorkerThreads from "node:worker_threads";
import { expect, it, onTestFinished } from "vite-plus/test";

it("keeps a fresh Claude thread handed off across MCP grant rotation", async () => {
  const worker = new NodeWorkerThreads.Worker(
    new URL("./tests/freshClaudeNativeHandoff.worker.ts", import.meta.url),
  );
  onTestFinished(async () => {
    await worker.terminate();
  });
  const received = await new Promise<unknown>((resolve, reject) => {
    let result: unknown;
    worker.once("message", (message: unknown) => {
      result = message;
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`Fresh Claude handoff worker exited ${code}.`));
      else resolve(result);
    });
  });
  if (received === null || typeof received !== "object")
    throw new Error("Fresh Claude handoff worker returned an invalid response.");
  if (Reflect.get(received, "ok") !== true)
    throw new Error(
      `Fresh Claude handoff worker failed: ${String(Reflect.get(received, "error"))}`,
    );
  expect(received).toMatchObject({ ok: true });
  if (
    Reflect.get(received, "report") === null ||
    typeof Reflect.get(received, "report") !== "object"
  )
    throw new Error("Fresh Claude handoff worker omitted its regression report.");
  const report = Reflect.get(received, "report") as Record<string, unknown>;
  const nativeId = report.nativeId;
  expect(report.firstFailure).toBeNull();
  expect(report.secondFailure).toBeNull();
  expect(typeof nativeId).toBe("string");
  expect(report).toMatchObject({
    initialNativeId: nativeId,
    creationAccessRetired: true,
    firstCheckpointNativeId: nativeId,
    secondCheckpointNativeId: nativeId,
    accessCalls: ["fresh:fresh-create", "turn:first-turn", "turn:second-turn"],
    turnGrantIssues: [
      { runId: "fresh-claude-first-turn", nativeTurnEpoch: 2 },
      { runId: "fresh-claude-second-turn", nativeTurnEpoch: 3 },
    ],
    firstStatus: "completed",
    secondStatus: "completed",
    firstCheckpointCompleted: true,
    secondCheckpointCompleted: true,
    sdkThreadIds: [nativeId],
    consumedMessages: 2,
    mcpInstallations: [["executor"], ["executor"]],
    mcpResponses: [
      "grant:gateway-fresh-claude-first-turn",
      "grant:gateway-fresh-claude-second-turn",
    ],
    executorGrants: ["gateway-fresh-claude-first-turn", "gateway-fresh-claude-second-turn"],
    executorEndpoints: ["https://gateway.product.test/", "https://gateway.product.test/"],
    creationRouteStatus: "never-queried",
  });
});
