import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import { AUTOMATIONS_CLOUD_ONLY_MESSAGE } from "../../signalbox/automationAvailability.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as Handlers from "./handlers.ts";
import { AutomationToolkit } from "./tools.ts";

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "automation-tools-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "automation-tools-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const layer = McpHttpServer.toolkitRegistration(AutomationToolkit, Handlers.layer).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
);

it.effect("returns the explicit cloud-only failure for automation MCP calls", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const inputs: Record<string, Record<string, unknown>> = {
      automation_reference: {},
      automation_validate: { source: "" },
      automation_save: { source: "" },
      automation_list: {},
      automation_read: { automationId: "automation_test" },
      automation_run: { automationId: "automation_test" },
      automation_run_read: { runId: "run_test" },
      automation_set_enabled: { automationId: "automation_test", enabled: true },
      automation_cancel_run: { runId: "run_test" },
      automation_run_retry: { runId: "run_test" },
      automation_publish: { automationId: "automation_test" },
      automation_discard_draft: { automationId: "automation_test" },
      automation_delete: { automationId: "automation_test" },
      automation_emit: { event: "test" },
      automation_set_webhook_secret: {
        automationId: "automation_test",
        secretRef: "secret_test",
      },
      automation_customize: { automationId: "builtin:test" },
      wait_for: { until: "something" },
      list_waits: {},
      stop_waiting: { waitId: "wait_test" },
      merge_pull_request: { url: "https://github.com/owner/repo/pull/1" },
    };
    expect(Object.keys(inputs)).toHaveLength(Object.keys(AutomationToolkit.tools).length);

    for (const tool of Object.values(AutomationToolkit.tools)) {
      const arguments_ = inputs[tool.name];
      if (arguments_ === undefined) throw new Error(`Missing test input for ${tool.name}.`);
      const result = yield* server.callTool({ name: tool.name, arguments: arguments_ });
      const content = result.content[0];

      expect(result.isError, tool.name).toBe(true);
      expect(content?.type === "text" ? JSON.parse(content.text) : undefined, tool.name).toEqual({
        _tag: "OrchestratorMcpFailure",
        code: "provider_unavailable",
        message: AUTOMATIONS_CLOUD_ONLY_MESSAGE,
      });
      expect(result.structuredContent, tool.name).toBeUndefined();
    }
  }).pipe(Effect.provide(layer), Effect.provideService(McpSchema.McpServerClient, client)),
);
