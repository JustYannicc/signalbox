import {
  OrchestratorMcpRequestSecretInput,
  OrchestratorMcpRequestSecretResult,
  RunAttemptId,
  RunId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { jsonCodec } from "./jsonCodec.ts";
import { SESSION_API_PREFIX } from "./SessionProtocol.ts";

/** Only request metadata and an opaque ref cross this route. Values stay in the thread object. */
export const SECRET_REQUEST_PATH = `${SESSION_API_PREFIX}/secret-request`;

export const SecretRequest = Schema.Struct({
  runId: RunId,
  attemptId: RunAttemptId,
  input: OrchestratorMcpRequestSecretInput,
});
export type SecretRequest = typeof SecretRequest.Type;

export const secretRequestJson = {
  request: jsonCodec(SecretRequest),
  result: jsonCodec(OrchestratorMcpRequestSecretResult),
};
