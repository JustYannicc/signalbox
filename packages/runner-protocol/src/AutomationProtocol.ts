import * as Schema from "effect/Schema";

import { DRIVE_API_PREFIX } from "./DriveProtocol.ts";
import { jsonCodec } from "./jsonCodec.ts";

/**
 * How a thread's agent uses automations in the cloud (#434): the thread's
 * machine serves the automation MCP tools (`automation_save`, `wait_for`, …)
 * and forwards each call here, with the thread's drive token
 * (`DriveProtocol.ts`), which names the thread the call acts for. The cloud's
 * engine answers as the thread's owner; the machine never says who it is.
 *
 * `automation_validate` and `automation_reference` never reach the cloud, and
 * `automation_save` arrives compiled: the compiler needs Node, so the machine
 * compiles and sends the `CompiledWorkflow` as `compiled` beside the save's
 * own input. The cloud trusts it as the thread's agent's own work (the agent
 * already runs with full access on that machine): `compiled` is what runs, in
 * the sandbox, and `source` is what people read.
 *
 * `tool` answers 200 with a `ToolResult` whether or not the engine did it: a
 * refusal is an answer for the agent, not a failure to retry.
 */

export const AUTOMATION_PATHS = {
  tool: `${DRIVE_API_PREFIX}/automations/tool`,
} as const;

/**
 * Signalbox's own tool on the same route: the team notes on the thread's
 * folders (#318). The machine declares it, the cloud answers it.
 */
export const LIST_NOTES_TOOL = "list_notes";

/** One tool call: its MCP name and its input as the agent gave it (plus `compiled` for a save). */
export const ToolRequest = Schema.Struct({
  name: Schema.String,
  input: Schema.Unknown,
});
export type ToolRequest = typeof ToolRequest.Type;

export const ToolResult = Schema.Union([
  /** What the tool returns, as the self-hosted server's tool returns it. */
  Schema.Struct({ _tag: Schema.Literal("ok"), result: Schema.Unknown }),
  /** Why the engine refused, in words for the agent. */
  Schema.Struct({ _tag: Schema.Literal("failed"), message: Schema.String }),
]);
export type ToolResult = typeof ToolResult.Type;

export const automationJson = {
  toolRequest: jsonCodec(ToolRequest),
  tool: jsonCodec(ToolResult),
};
