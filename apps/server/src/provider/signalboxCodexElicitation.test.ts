import { describe, expect, it } from "vite-plus/test";
import type * as CodexSchema from "effect-codex-app-server/schema";
import {
  codexMcpElicitationForm,
  codexMcpElicitationResponse,
  isCodexMcpApproval,
} from "./signalboxCodexElicitation.ts";

const request = {
  mode: "form",
  message: "Choose a region",
  serverName: "reports",
  threadId: "thread",
  turnId: "turn",
  requestedSchema: {
    type: "object",
    properties: {
      region: {
        type: "string",
        oneOf: [
          { const: "eu", title: "Europe" },
          { const: "us", title: "US" },
        ],
      },
    },
    required: ["region"],
  },
} satisfies CodexSchema.McpServerElicitationRequestParams;

describe("Codex MCP elicitation forms", () => {
  it("asks for actual form content and preserves the choice title", () => {
    expect(codexMcpElicitationForm(request)?.questions[0]?.options[0]).toEqual({
      label: "Europe",
      value: "eu",
      description: "Europe",
    });
    expect(codexMcpElicitationResponse(request, { region: "us" })).toEqual({
      action: "accept",
      content: { region: "us" },
    });
    expect(codexMcpElicitationResponse(request, {})).toEqual({ action: "decline" });
  });
  it("keeps URL elicitation off the ordinary question path", () => {
    const url = {
      mode: "url",
      url: "https://example.com/sign-in",
      elicitationId: "sign-in",
      message: "Sign in",
      serverName: "reports",
      threadId: "thread",
      turnId: "turn",
    } satisfies CodexSchema.McpServerElicitationRequestParams;
    expect(codexMcpElicitationForm(url)).toBeNull();
    expect(codexMcpElicitationResponse(url, {})).toEqual({ action: "decline" });
  });
  it("does not use defaults or approval heuristics to answer an unanswered required field", () => {
    const form = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: { approval: { type: "string", default: "once", enum: ["once", "always"] } },
        required: ["approval"],
      },
    } satisfies CodexSchema.McpServerElicitationRequestParams;
    expect(codexMcpElicitationResponse(form, {})).toEqual({ action: "decline" });
    expect(codexMcpElicitationResponse(form, { approval: "always" })).toEqual({
      action: "accept",
      content: { approval: "always" },
    });
  });
});

it("keeps data forms separate from Computer Use and metadata approvals", () => {
  expect(isCodexMcpApproval(request)).toBe(false);
  expect(isCodexMcpApproval({ ...request, message: "Allow ChatGPT to use Safari?" })).toBe(true);
  expect(isCodexMcpApproval({ ...request, _meta: { codex_approval_kind: "mcp_tool_call" } })).toBe(
    true,
  );
  expect(
    isCodexMcpApproval({ ...request, requestedSchema: { type: "object", properties: {} } }),
  ).toBe(true);
  expect(isCodexMcpApproval({ ...request, _meta: { persist: ["session", "always"] } })).toBe(true);
});
