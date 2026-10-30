import * as Schema from "effect/Schema";
import {
  createHarnessCProductExecutorService,
  type HarnessCProductAccessService,
} from "../../../../src/harness/HarnessCProductCapabilities.ts";
import type { HarnessContinuation } from "../../../../src/harness/HarnessContinuations.ts";
import { sameData } from "../../../../src/harness/HarnessProcessResume.ts";
import type { ClaudeMcpProbe } from "./claudeMcpProbe.ts";

const Grant = Schema.Struct({
  fixture: Schema.Literal("deploy3-claude-access/v1"),
  runId: Schema.String,
  threadId: Schema.String,
});
type FixtureGrant = typeof Grant.Type;
const decodeGrant = Schema.decodeUnknownSync(Grant);
const Message = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
const decodeMessage = Schema.decodeUnknownSync(Message);

export function requireFixtureMcpProbe(probe: ClaudeMcpProbe) {
  if (
    probe.toolName !== "mcp__executor__qualification_echo" ||
    Object.keys(probe.input).length !== 1 ||
    typeof probe.input.text !== "string" ||
    !probe.input.text.trim() ||
    probe.expectedText !== probe.input.text
  )
    throw new Error("CLAUDE_QUALIFICATION_LOCAL_ECHO_PROBE_REQUIRED");
  return probe;
}

/** Disposable services use the normal access/MCP/continuation contracts and never contact Executor. */
export function createClaudeFixtureServices(input: {
  readonly runId: string;
  readonly threadIds: readonly string[];
  readonly probe: ClaudeMcpProbe;
  readonly record: (kind: string, value: unknown) => Promise<unknown>;
}) {
  const probe = requireFixtureMcpProbe(input.probe);
  const access = async (phase: string, identity: { readonly threadId: string }) => {
    if (!input.threadIds.includes(identity.threadId))
      throw new Error("CLAUDE_QUALIFICATION_FIXTURE_THREAD_MISMATCH");
    await input.record("claude-fixture-access", { phase, identity });
    return {
      grant: {
        fixture: "deploy3-claude-access/v1" as const,
        runId: input.runId,
        threadId: identity.threadId,
      },
      connections: { servers: [] },
    };
  };
  const authority: HarnessCProductAccessService<FixtureGrant> = {
    resolveFreshAccess: (identity) => access("fresh", identity),
    resolveInitialAccess: (identity) => access("restore", identity),
    resolveTurnAccess: (identity) => access("turn", identity),
  };
  const executor = createHarnessCProductExecutorService<unknown>({
    forward: async ({ target, grant: raw, request, signal }) => {
      signal.throwIfAborted();
      const grant = decodeGrant(raw);
      if (
        grant.runId !== input.runId ||
        !input.threadIds.includes(grant.threadId) ||
        target.type !== "executor"
      )
        throw new Error("CLAUDE_QUALIFICATION_FIXTURE_GRANT_MISMATCH");
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      if (request.method !== "POST")
        return new Response("Only local JSON-RPC POST is supported", { status: 405 });
      const message = decodeMessage(await request.json());
      if (message.id === undefined) {
        if (message.method !== "notifications/initialized")
          throw new Error("CLAUDE_FIXTURE_MCP_NOTIFICATION_UNSUPPORTED");
        return new Response(null, { status: 202 });
      }
      let result: unknown;
      switch (message.method) {
        case "initialize":
          result = {
            protocolVersion:
              typeof message.params?.protocolVersion === "string"
                ? message.params.protocolVersion
                : "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "signalbox-qualification-fixture", version: "1" },
          };
          break;
        case "ping":
          result = {};
          break;
        case "tools/list":
          result = {
            tools: [
              {
                name: "qualification_echo",
                description: "Echo the disposable qualification input",
                inputSchema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                  additionalProperties: false,
                },
              },
            ],
          };
          break;
        case "tools/call":
          if (
            message.params?.name !== "qualification_echo" ||
            !sameData(message.params.arguments, probe.input)
          )
            throw new Error("CLAUDE_QUALIFICATION_FIXTURE_MCP_INPUT_MISMATCH");
          result = { content: [{ type: "text", text: probe.expectedText }], isError: false };
          break;
        default:
          throw new Error("CLAUDE_FIXTURE_MCP_METHOD_UNSUPPORTED");
      }
      signal.throwIfAborted();
      await input.record("claude-fixture-mcp", {
        threadId: grant.threadId,
        request: message,
        result,
      });
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    },
  });
  return {
    ...authority,
    forward: executor.forward,
    async publishContinuation(request: HarnessContinuation) {
      if (request.driver !== "claudeAgent" || !input.threadIds.includes(request.threadId))
        throw new Error("CLAUDE_QUALIFICATION_FIXTURE_CONTINUATION_MISMATCH");
      await input.record("claude-fixture-continuation", request);
    },
  };
}

export const CLAUDE_FIXTURE_BINDINGS = {
  namespace: {
    binding: "CLAUDE_FIXTURES",
    className: "QualifierClaudeFixtures",
    fixture: "disposable-per-run-services/v1",
  },
  access: {
    capability: "access",
    fixture: "deploy3-claude-access/v1",
    implementation:
      "QualifierClaudeFixtures.resolveFreshAccess/resolveInitialAccess/resolveTurnAccess",
  },
  mcp: {
    capability: "executor",
    fixture: "local-jsonrpc-qualification-echo/v1",
    implementation: "QualifierClaudeFixtures.forward",
    realExecutor: false,
  },
  continuation: {
    capability: "claudeContinuationPublisher",
    fixture: "recorded-continuation/v1",
    implementation: "QualifierClaudeFixtures.publishContinuation",
  },
  model: {
    capability: "model",
    fixture: "recorded-anthropic-messages/v1",
    implementation: "QualifierProof.fetch → ClaudeQualificationModelPeer",
    networkModel: false,
  },
} as const;
