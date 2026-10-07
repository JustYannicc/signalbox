import * as AiError from "effect/ai/AiError";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import type { McpCapability, McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../mcp/ThreadMetadataMcpService.ts";
import * as EnvironmentHandlers from "../../mcp/toolkits/environment/handlers.ts";
import { EnvironmentToolkit } from "../../mcp/toolkits/environment/tools.ts";
import * as OrchestratorHandlers from "../../mcp/toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "../../mcp/toolkits/orchestrator/tools.ts";
import * as ProjectHandlers from "../../mcp/toolkits/project/handlers.ts";
import { ProjectToolkit } from "../../mcp/toolkits/project/tools.ts";
import * as PullRequestsHandlers from "../../mcp/toolkits/pullRequests/handlers.ts";
import { PullRequestsToolkit } from "../../mcp/toolkits/pullRequests/tools.ts";
import * as ThreadHandlers from "../../mcp/toolkits/thread/handlers.ts";
import { ThreadToolkit } from "../../mcp/toolkits/thread/tools.ts";
import { automationError, errorMessage } from "../errors.ts";
import { asRecord } from "../json.ts";
import * as WorkflowEngine from "../WorkflowEngine.ts";
import type { BuiltinToolCall } from "./runner.ts";

/**
 * Hands the engine Signalbox's MCP tool handlers, so `w.call("…",
 * "signalbox.<tool>", args)` runs exactly what an agent's call runs. McpHttpServer
 * merges this layer next to its toolkits; the handler layers are the same
 * values it uses, so they're built once.
 *
 * An automation calls as an MCP client without a thread whose access is its
 * own runtime mode, so it can't borrow access, and tools that act as the
 * caller's thread need `threadId`. A thread can't be the caller even for runs
 * attached to one: thread callers need the thread's live turn to change
 * anything, and an attached run acts while the thread is idle.
 *
 * Left out: tools that need a calling thread or a person at a client (delegate
 * and task tools, create_threads, request_secret, worktree handoff, preview,
 * browser, device, attachments), and the automation tools themselves, which
 * `w.start` and steps already cover.
 */

const EXCLUDED = new Set([
  "delegate_task",
  "task_status",
  "task_cancel",
  "create_threads",
  "request_secret",
]);

/** The capabilities an automation's calls carry: threads and pull requests, nothing tied to a client. */
const CAPABILITIES: ReadonlySet<McpCapability> = new Set(["orchestration", "pull-requests"]);

type Handle = (
  name: string,
  params: unknown,
) => Effect.Effect<
  Stream.Stream<
    { readonly isFailure: boolean; readonly result: unknown; readonly encodedResult: unknown },
    unknown,
    never
  >,
  AiError.AiError,
  never
>;

interface HandledToolkit {
  readonly tools: Readonly<Record<string, { readonly parametersSchema: unknown }>>;
  readonly handle: Handle;
}

/** Whether a tool takes `clientRequestId`, which the step then fills in for idempotency. */
const takesRequestId = (tool: { readonly parametersSchema: unknown }) =>
  Schema.isSchema(tool.parametersSchema) &&
  "fields" in tool.parametersSchema &&
  typeof tool.parametersSchema.fields === "object" &&
  tool.parametersSchema.fields !== null &&
  "clientRequestId" in tool.parametersSchema.fields;

const register = Effect.gen(function* () {
  const engine = yield* WorkflowEngine.WorkflowEngine;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  // The handlers' own services, given back on every call like the MCP server does.
  const services = yield* Effect.context<never>();
  // Typed per toolkit; erased here so one table can route any tool name.
  const toolkits: ReadonlyArray<HandledToolkit> = [
    (yield* OrchestratorToolkit) as unknown as HandledToolkit,
    (yield* ThreadToolkit) as unknown as HandledToolkit,
    (yield* ProjectToolkit) as unknown as HandledToolkit,
    (yield* PullRequestsToolkit) as unknown as HandledToolkit,
    (yield* EnvironmentToolkit) as unknown as HandledToolkit,
  ];
  const routes = new Map<string, HandledToolkit>();
  for (const toolkit of toolkits)
    for (const name of Object.keys(toolkit.tools))
      if (!EXCLUDED.has(name)) routes.set(name, toolkit);

  const call = (input: BuiltinToolCall) =>
    Effect.gen(function* () {
      const toolkit = routes.get(input.tool)!;
      const args = asRecord(input.args);
      const params =
        takesRequestId(toolkit.tools[input.tool]!) && args.clientRequestId === undefined
          ? { ...args, clientRequestId: input.requestKey }
          : input.args;
      const scope: McpInvocationScope = {
        environmentId,
        capabilities: CAPABILITIES,
        issuedAt: yield* Clock.currentTimeMillis,
        requestNamespace: `automation:${input.automationId}`,
        thread: undefined,
        client: {
          sessionId: `automation:${input.automationId}`,
          label: `Automation "${input.automationName}"`,
          access: input.runtimeMode,
        },
      };
      const failed = (cause: unknown) =>
        automationError(`signalbox.${input.tool} failed: ${errorMessage(cause)}`, { cause });
      const last = yield* toolkit.handle(input.tool, params).pipe(
        Effect.flatMap((results) => Stream.run(results.pipe(Stream.mapError(failed)), Sink.last())),
        Effect.mapError(failed),
        Effect.provideContext(
          Context.add(services, McpInvocationContext.McpInvocationContext, scope),
        ),
      );
      if (Option.isNone(last)) return null;
      // Tools that return their failures report them as a failed result.
      if (last.value.isFailure) return yield* failed(last.value.result);
      return last.value.encodedResult;
    });

  yield* engine.registerBuiltinTools({ tools: [...routes.keys()].toSorted(), call });
});

export const layer = Layer.effectDiscard(register).pipe(
  Layer.provide(
    Layer.mergeAll(
      McpToolAccess.HandlersLayer.layer(OrchestratorHandlers.layer),
      McpToolAccess.HandlersLayer.layer(ThreadHandlers.layer),
      McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer),
      McpToolAccess.HandlersLayer.layer(PullRequestsHandlers.layer),
      McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer),
    ),
  ),
  Layer.provide(Layer.mergeAll(OrchestratorMcpService.layer, ThreadMetadataMcpService.layer)),
);
