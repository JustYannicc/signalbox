import type { HarnessTurnStage } from "../HarnessTurnProgress.ts";

const MAX_CONTROL_FRAME_BYTES = 65_536;
const MAX_CONTROL_FRAMES = 64;
const MAX_OBSERVED_BYTES = 1_048_576;
const MAX_RESPONSE_IDS = 16;

function controlFrames(onFrame: (value: unknown) => void) {
  const buffer = new Uint8Array(MAX_CONTROL_FRAME_BYTES);
  const decoder = new TextDecoder();
  let length = 0;
  let discarded = false;
  let frames = 0;
  let observed = 0;
  return (bytes: Uint8Array) => {
    for (const byte of bytes) {
      if (frames >= MAX_CONTROL_FRAMES || observed++ >= MAX_OBSERVED_BYTES) return;
      if (byte === 10) {
        frames++;
        if (!discarded && length > 0) {
          let value: unknown;
          try {
            value = JSON.parse(decoder.decode(buffer.subarray(0, length)));
          } catch {
            length = 0;
            continue;
          }
          onFrame(value);
        }
        length = 0;
        discarded = false;
      } else if (!discarded) {
        if (length === buffer.byteLength) {
          length = 0;
          discarded = true;
        } else buffer[length++] = byte;
      }
    }
  };
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Reflect.get(value, key)
    : undefined;

const requestId = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 128 ? value : undefined;

/** Observes accepted pipe writes; it never reads a stream or changes the SDK's framing. */
export function createClaudeInitializationProgress(report: (stage: HarnessTurnStage) => void) {
  const reported = new Set<HarnessTurnStage>();
  const responses = new Set<string>();
  let initializeId: string | undefined;
  let responseReceived = false;
  const once = (stage: HarnessTurnStage) => {
    if (reported.has(stage)) return;
    reported.add(stage);
    report(stage);
  };
  const matchResponse = () => {
    if (initializeId === undefined || !responses.has(initializeId)) return;
    responseReceived = true;
    responses.clear();
    once("control-response-received");
  };
  const input = controlFrames((value) => {
    if (
      initializeId !== undefined ||
      field(value, "type") !== "control_request" ||
      field(field(value, "request"), "subtype") !== "initialize"
    )
      return;
    const id = requestId(field(value, "request_id"));
    if (id === undefined) return;
    initializeId = id;
    once("control-initialize-sent");
    matchResponse();
  });
  const output = controlFrames((value) => {
    if (field(value, "type") !== "control_response") return;
    const id = requestId(field(field(value, "response"), "request_id"));
    if (id === undefined) return;
    if (responses.size === MAX_RESPONSE_IDS) {
      const oldest = responses.values().next().value;
      if (oldest !== undefined) responses.delete(oldest);
    }
    responses.add(id);
    matchResponse();
  });
  return {
    cliSpawned: () => once("cli-spawned"),
    compatibilityChecking: () => once("runtime-compatibility-checking"),
    compatibilityConfirmed: () => once("runtime-compatibility-confirmed"),
    acceptedWrite(fd: 0 | 1 | 2, bytes: Uint8Array) {
      if (bytes.byteLength === 0) return;
      if (fd === 2) {
        once("cli-stderr-bytes");
        return;
      }
      if (fd === 1) once("cli-first-stdout-byte");
      if (responseReceived) return;
      if (fd === 0) input(bytes);
      else output(bytes);
    },
  };
}
