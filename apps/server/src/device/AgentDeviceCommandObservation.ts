import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { HttpClientResponse } from "effect/http";

import * as AgentDeviceProxyRegistry from "./AgentDeviceProxyRegistry.ts";
import * as DeviceAgentDiagnostics from "./DeviceAgentDiagnostics.ts";
import * as DeviceService from "./DeviceService.ts";
import {
  findAgentDeviceSession,
  sameAgentDeviceSession,
  type AgentDeviceSession,
} from "./AgentDeviceSession.ts";
import {
  agentDeviceCommandOutcome,
  agentDeviceCommandOutcomeFromNdjsonRecord,
  type AgentDeviceCommandOutcome,
} from "./AgentDeviceRpc.ts";

const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_NDJSON_RECORD_CHARS = 64 * 1024;

const truncatedResponse = (status: number, command: string): AgentDeviceCommandOutcome =>
  status >= 200 && status < 300
    ? null
    : {
        kind: "failure",
        failure: {
          command,
          message: "Agent-device returned a command response too large to inspect.",
        },
      };

export const observeAgentDeviceCommandResponse = (
  response: HttpClientResponse.HttpClientResponse,
  input: {
    readonly command: string;
    readonly commandGeneration: number;
    readonly session: AgentDeviceSession;
    readonly registration: AgentDeviceProxyRegistry.RegisteredAgentDeviceEndpoint;
    readonly proxyRegistry: AgentDeviceProxyRegistry.AgentDeviceProxyRegistry["Service"];
    readonly proxyToken: string;
    readonly daemonToken: string;
    readonly devices: DeviceService.DeviceService["Service"];
    readonly diagnostics: DeviceAgentDiagnostics.DeviceAgentDiagnostics["Service"];
  },
) => {
  const ndjson =
    response.headers["content-type"]?.toLowerCase().includes("application/x-ndjson") ?? false;
  const decoder = new TextDecoder();
  const captured: Array<Uint8Array> = [];
  let capturedBytes = 0;
  let jsonResponseTooLarge = false;
  let ndjsonResponseTooLarge = false;
  let line = "";
  let lineTooLarge = false;
  let observedOutcome: AgentDeviceCommandOutcome = null;

  const observeRecord = (record: string) => {
    if (observedOutcome !== null || record.length === 0 || lineTooLarge) return;
    observedOutcome = agentDeviceCommandOutcomeFromNdjsonRecord({
      body: record,
      status: response.status,
      command: input.command,
      tokens: [input.proxyToken, input.daemonToken],
    });
  };

  const appendText = (text: string) => {
    let rest = text;
    while (rest.length > 0) {
      const newline = rest.indexOf("\n");
      const part = newline < 0 ? rest : rest.slice(0, newline);
      if (!lineTooLarge) {
        if (line.length + part.length > MAX_NDJSON_RECORD_CHARS) {
          ndjsonResponseTooLarge = true;
          line = "";
          lineTooLarge = true;
        } else {
          line += part;
        }
      }
      if (newline < 0) break;
      observeRecord(line.replace(/\r$/, ""));
      line = "";
      lineTooLarge = false;
      rest = rest.slice(newline + 1);
    }
  };

  const responseStream = response.stream.pipe(
    Stream.tap((chunk) =>
      Effect.sync(() => {
        if (ndjson) {
          appendText(decoder.decode(chunk, { stream: true }));
          return;
        }
        if (jsonResponseTooLarge) return;
        if (capturedBytes + chunk.byteLength > MAX_JSON_RESPONSE_BYTES) {
          jsonResponseTooLarge = true;
          captured.length = 0;
          capturedBytes = 0;
          return;
        }
        captured.push(Uint8Array.from(chunk));
        capturedBytes += chunk.byteLength;
      }),
    ),
    Stream.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.gen(function* () {
            let outcome: AgentDeviceCommandOutcome;
            if (ndjson) {
              appendText(decoder.decode());
              observeRecord(line.replace(/\r$/, ""));
              outcome = observedOutcome;
              if (outcome === null) {
                outcome = ndjsonResponseTooLarge
                  ? truncatedResponse(response.status, input.command)
                  : agentDeviceCommandOutcome({
                      body: "",
                      contentType: response.headers["content-type"],
                      status: response.status,
                      command: input.command,
                      tokens: [input.proxyToken, input.daemonToken],
                    });
              }
            } else if (jsonResponseTooLarge) {
              outcome = truncatedResponse(response.status, input.command);
            } else {
              const bytes = new Uint8Array(capturedBytes);
              let offset = 0;
              for (const chunk of captured) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
              }
              outcome = agentDeviceCommandOutcome({
                body: new TextDecoder().decode(bytes),
                contentType: response.headers["content-type"],
                status: response.status,
                command: input.command,
                tokens: [input.proxyToken, input.daemonToken],
              });
            }
            if (!outcome) return;

            const currentRegistration = yield* input.proxyRegistry.isCurrent(input.registration);
            if (!currentRegistration) return;
            const after = findAgentDeviceSession(
              yield* input.devices.state,
              input.session.sessionId,
            );
            if (!after || !sameAgentDeviceSession(input.session, after)) return;
            if (outcome.kind === "failure") {
              yield* input.diagnostics.recordFailure(
                after,
                input.commandGeneration,
                outcome.failure,
              );
            } else {
              yield* input.diagnostics.clearSessionFailure(after, input.commandGeneration);
            }
          }).pipe(Effect.ignore)
        : Effect.void,
    ),
  );

  return responseStream;
};
