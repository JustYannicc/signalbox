import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Sections from "../../../sections/Sections.ts";
import { SectionStorageError } from "../../../sections/SectionsError.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Handlers from "./handlers.ts";
import { SectionsToolkit } from "./tools.ts";

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("sections-test"),
  requestNamespace: "sections-test",
  issuedAt: 0,
  thread: undefined,
  client: { sessionId: "session", label: "Test", access: "full-access" },
  capabilities: new Set(["orchestration"]),
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const testLayer = McpHttpServer.toolkitRegistration(SectionsToolkit, Handlers.layer).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
);

const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const content = result.content[0];
  return result.isError && content?.type === "text" ? decodeJson(content.text) : undefined;
};

it.effect("rejects section reads without orchestration capability before reading state", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server.callTool({ name: "t3_section_list", arguments: {} });
    expect(declaredFailure(result)).toMatchObject({ code: "capability_denied" });
  }).pipe(
    Effect.provide(testLayer),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      ...scope,
      capabilities: new Set<never>(),
    }),
  ),
);

it.effect("allows section reads but rejects organization changes below full access", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const listed = yield* server.callTool({ name: "t3_section_list", arguments: {} });
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toEqual({
      revision: 0,
      sections: [],
      projectPlacements: [],
    });
    const moved = yield* server.callTool({
      name: "t3_project_move_to_section",
      arguments: { projectId: ProjectId.make("project"), sectionId: null },
    });
    expect(declaredFailure(moved)).toMatchObject({ code: "capability_denied" });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        testLayer,
        Layer.mock(Sections.Sections)({
          snapshot: Effect.succeed({ revision: 0, sections: [], projectPlacements: [] }),
        }),
      ),
    ),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      ...scope,
      client: { sessionId: "session", label: "Test", access: "approval-required" },
    }),
  ),
);

it.effect("keeps storage causes out of MCP failures", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server.callTool({ name: "t3_section_list", arguments: {} });
    expect(declaredFailure(result)).toEqual({
      _tag: "OrchestratorMcpFailure",
      code: "orchestration_error",
      message: "The operation could not be completed.",
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        testLayer,
        Layer.mock(Sections.Sections)({
          snapshot: Effect.fail(
            new SectionStorageError({
              operation: "read",
              cause: new Error("private-database-path"),
            }),
          ),
        }),
      ),
    ),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
  ),
);
