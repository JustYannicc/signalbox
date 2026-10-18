import { AuthEnvironmentScopes } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Carries a call's credential from the Worker. Objects aren't reachable from the internet. */
export const API_HEADER = "x-signalbox-api";

export const ApiCredential = Schema.Union([
  /**
   * A personal key; the object looks up its scopes. `agent`: an agent is using
   * the person's key (`signalbox mcp`), so the call gets an agent's limits.
   */
  Schema.TaggedStruct("key", { secret: Schema.String, agent: Schema.optionalKey(Schema.Boolean) }),
  /** An agent acting for the person, as the Worker verified (MCP). */
  Schema.TaggedStruct("agent", { sid: Schema.String, scopes: AuthEnvironmentScopes }),
]);
export type ApiCredential = typeof ApiCredential.Type;
export const encodeApiCredential = Schema.encodeSync(Schema.fromJsonString(ApiCredential));
export const decodeApiCredential = Schema.decodeUnknownOption(Schema.fromJsonString(ApiCredential));
