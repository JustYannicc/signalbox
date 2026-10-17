import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { HttpClientResponse } from "effect/http";

import * as DeviceAgentDiagnostics from "./DeviceAgentDiagnostics.ts";
import * as DeviceService from "./DeviceService.ts";
import {
  findAgentDeviceSession,
  sameAgentDeviceSession,
  type AgentDeviceSession,
} from "./AgentDeviceSession.ts";
import { agentDeviceCommandOutcome } from "./AgentDeviceRpc.ts";

const MAX_OBSERVED_RESPONSE_BYTES = 2 * 1024 * 1024;

export const observeAgentDeviceCommandResponse = (
  response: HttpClientResponse.HttpClientResponse,
  input: {
    readonly command: string;
    readonly session: AgentDeviceSession;
    readonly proxyToken: string;
    readonly daemonToken: string;
    readonly devices: DeviceService.DeviceService["Service"];
    readonly diagnostics: DeviceAgentDiagnostics.DeviceAgentDiagnostics["Service"];
  },
) => {
  const captured: Array<Uint8Array> = [];
  let capturedBytes = 0;
  let responseTruncated = false;

  return response.stream.pipe(
    Stream.tap((chunk) =>
      Effect.sync(() => {
        if (responseTruncated) return;
        if (capturedBytes + chunk.byteLength > MAX_OBSERVED_RESPONSE_BYTES) {
          responseTruncated = true;
          captured.length = 0;
          capturedBytes = 0;
          return;
        }
        captured.push(Uint8Array.from(chunk));
        capturedBytes += chunk.byteLength;
      }),
    ),
    Stream.onExit((exit) =>
      Exit.isSuccess(exit) && !responseTruncated
        ? Effect.gen(function* () {
            const bytes = new Uint8Array(capturedBytes);
            let offset = 0;
            for (const chunk of captured) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            const outcome = agentDeviceCommandOutcome({
              body: new TextDecoder().decode(bytes),
              contentType: response.headers["content-type"],
              status: response.status,
              command: input.command,
              tokens: [input.proxyToken, input.daemonToken],
            });
            if (!outcome) return;
            const after = findAgentDeviceSession(
              yield* input.devices.state,
              input.session.sessionId,
            );
            if (!after || !sameAgentDeviceSession(input.session, after)) return;
            if (outcome.kind === "failure") {
              yield* input.diagnostics.recordFailure(after, outcome.failure);
            } else {
              yield* input.diagnostics.clearSessionFailure(after);
            }
          }).pipe(Effect.ignore)
        : Effect.void,
    ),
  );
};
