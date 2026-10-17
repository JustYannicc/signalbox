import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { findOperation, jsonSchemaOf, type Operation } from "./catalog.ts";
import { searchOperations } from "./search.ts";

/**
 * Signalbox's MCP tools: `signalbox_search` finds operations by intent and
 * returns their input schemas; `signalbox_call` calls one. Two tools however
 * many operations there are, the shape of Cloudflare's and Executor's tool
 * search (#335). The cloud serves them on `/mcp` and the CLI over stdio
 * (`signalbox mcp`); each provides `SignalboxApi` for its transport.
 *
 * An MCP caller is always an agent. Human-only operations are refused;
 * destructive operations require an explicit reach entry allowing agents.
 */

/** Whether the Signalbox behind the tools serves an operation, and if not, why. */
export type Coverage =
  | { readonly served: true }
  | { readonly served: false; readonly issue?: string; readonly reason?: string };

export class SignalboxApiCallError extends Schema.TaggedError<SignalboxApiCallError>()(
  "SignalboxApiCallError",
  {
    status: Schema.Number,
    /** The API's error body. */
    error: Schema.Unknown,
  },
) {}

export class SignalboxApi extends Context.Service<
  SignalboxApi,
  {
    /** Calls `operation` as the agent, with the person's folders and the agent's limits. */
    readonly call: (
      operation: Operation,
      input: Record<string, unknown>,
    ) => Effect.Effect<unknown, SignalboxApiCallError>;
    readonly coverage: (operation: Operation) => Coverage;
  }
>()("@signalbox/api/mcpTools/SignalboxApi") {}

const forAgents = (operation: Operation) => operation.agentCallable;

const SearchResult = Schema.Struct({
  operations: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      summary: Schema.optionalKey(Schema.String),
      access: Schema.Literals(["read", "write"]),
      destructive: Schema.Boolean,
      /** Present for streams: what one call answers with. */
      stream: Schema.optionalKey(Schema.String),
      available: Schema.Boolean,
      /** Why it isn't available here: the issue that adds it, or a reason. */
      unavailable: Schema.optionalKey(Schema.String),
      /** JSON Schema of `input` for signalbox_call. */
      input: Schema.Unknown,
    }),
  ),
});

const SearchTool = Tool.make("signalbox_search", {
  description:
    'Find Signalbox operations by what you want to do, e.g. "create a folder", "list automations", "send a message to a thread", "change a setting". Returns up to `limit` operations with their input JSON Schema. Then call one with signalbox_call. Areas: threads, folders, automations, pools, settings, keys, drives, previews, pull requests.',
  parameters: Schema.Struct({
    query: Schema.String,
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
  }),
  success: SearchResult,
  dependencies: [SignalboxApi],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const CallTool = Tool.make("signalbox_call", {
  description:
    "Call a Signalbox operation found with signalbox_search, as the person you work for. `input` must match the operation's input schema. Commands (threads.*) fill in their own commandId.",
  parameters: Schema.Struct({
    operation: Schema.String,
    input: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  success: Schema.Unknown,
  failure: SignalboxApiCallError,
  failureMode: "return",
  dependencies: [SignalboxApi],
}).annotate(Tool.Destructive, true);

export const SignalboxToolkit = Toolkit.make(SearchTool, CallTool);

const unavailableText = (coverage: Coverage) =>
  coverage.served
    ? undefined
    : coverage.issue !== undefined
      ? `Not in this Signalbox yet (${coverage.issue}).`
      : (coverage.reason ?? "Not in this Signalbox.");

export const layerSignalboxTools = SignalboxToolkit.toLayer(
  Effect.succeed(
    SignalboxToolkit.of({
      signalbox_search: ({ query, limit }) =>
        Effect.gen(function* () {
          const api = yield* SignalboxApi;
          const found = searchOperations(query, { limit: limit ?? 8, include: forAgents });
          return {
            operations: found.map((operation) => {
              const coverage = api.coverage(operation);
              const unavailable = unavailableText(coverage);
              const input = jsonSchemaOf(operation.input);
              return {
                name: operation.name,
                ...(operation.summary === undefined ? {} : { summary: operation.summary }),
                access: operation.access,
                destructive: operation.destructive,
                ...(operation.stream === undefined ? {} : { stream: operation.stream }),
                available: coverage.served,
                ...(unavailable === undefined ? {} : { unavailable }),
                input: { ...input.schema, $defs: input.definitions },
              };
            }),
          };
        }),
      signalbox_call: ({ operation: name, input }) =>
        Effect.gen(function* () {
          const api = yield* SignalboxApi;
          const operation = findOperation(name);
          if (operation === undefined || !forAgents(operation)) {
            return yield* new SignalboxApiCallError({
              status: 404,
              error: { message: `No operation ${name} you can call. Use signalbox_search.` },
            });
          }
          return yield* api.call(operation, input ?? {});
        }),
    }),
  ),
);
