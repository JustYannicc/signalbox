import { expect, it } from "vite-plus/test";
import { createClaudeInitializationProgress } from "../ClaudeInitializationProgress.ts";
import type { HarnessTurnStage } from "../HarnessTurnProgress.ts";

const encoder = new TextEncoder();
const initialize = (id: string) =>
  encoder.encode(
    `${JSON.stringify({
      type: "control_request",
      request_id: id,
      request: { subtype: "initialize", label: "λ" },
    })}\n`,
  );
const response = (id: string, subtype = "success") =>
  encoder.encode(
    `${JSON.stringify({ type: "control_response", response: { subtype, request_id: id } })}\n`,
  );
const fixture = () => {
  const stages: HarnessTurnStage[] = [];
  return {
    stages,
    progress: createClaudeInitializationProgress((stage) => stages.push(stage)),
  };
};

it("correlates split UTF-8 initialize and response frames after accepted writes", () => {
  const { progress, stages } = fixture();
  const request = initialize("init-1");
  for (const byte of request.subarray(0, -1)) progress.acceptedWrite(0, Uint8Array.of(byte));
  expect(stages).not.toContain("control-initialize-sent");
  progress.acceptedWrite(0, request.subarray(-1));
  expect(stages).toEqual(["control-initialize-sent"]);

  const reply = response("init-1");
  progress.acceptedWrite(1, reply.subarray(0, -1));
  expect(stages).toContain("cli-first-stdout-byte");
  expect(stages).not.toContain("control-response-received");
  progress.acceptedWrite(1, reply.subarray(-1));
  expect(stages).toContain("control-response-received");
});

it("does not mistake another control reply or a malformed frame for initialization", () => {
  const { progress, stages } = fixture();
  progress.acceptedWrite(
    0,
    encoder.encode(
      '{"type":"control_request","request_id":"other","request":{"subtype":"set_model"}}\n',
    ),
  );
  progress.acceptedWrite(1, response("other"));
  expect(stages).not.toContain("control-initialize-sent");
  expect(stages).not.toContain("control-response-received");
  progress.acceptedWrite(0, initialize("init-2"));
  progress.acceptedWrite(1, encoder.encode('not json\n{"type":"control_response"}\n'));
  progress.acceptedWrite(1, response("wrong"));
  expect(stages).not.toContain("control-response-received");
  progress.acceptedWrite(1, response("init-2", "error"));
  expect(stages).toContain("control-response-received");
  expect(stages).not.toContain("runtime-compatibility-confirmed");
});

it("retains response correlation when the pipe reader runs before the input observer", () => {
  const { progress, stages } = fixture();
  progress.acceptedWrite(1, response("init-race"));
  expect(stages).toEqual(["cli-first-stdout-byte"]);
  progress.acceptedWrite(0, initialize("init-race"));
  expect(stages.slice(-2)).toEqual(["control-initialize-sent", "control-response-received"]);
});

it("observes a response larger than the retained raw output prefix", () => {
  const { progress, stages } = fixture();
  progress.acceptedWrite(0, initialize("large"));
  const reply = encoder.encode(
    `${JSON.stringify({
      type: "control_response",
      response: { request_id: "large", subtype: "success", metadata: "x".repeat(24_000) },
    })}\n`,
  );
  for (let offset = 0; offset < reply.length; offset += 997)
    progress.acceptedWrite(1, reply.subarray(offset, offset + 997));
  expect(stages).toContain("control-response-received");
});

it("discards an oversized line as a whole and resumes at the next newline", () => {
  const { progress, stages } = fixture();
  progress.acceptedWrite(0, initialize("after-overflow"));
  progress.acceptedWrite(1, encoder.encode("x".repeat(128_000)));
  progress.acceptedWrite(1, response("after-overflow"));
  expect(stages).not.toContain("control-response-received");
  progress.acceptedWrite(1, response("after-overflow"));
  expect(stages).toContain("control-response-received");
});

it("keeps stderr and compatibility milestones bounded and separate from protocol success", () => {
  const { progress, stages } = fixture();
  for (let index = 0; index < 1_000; index++) {
    progress.cliSpawned();
    progress.acceptedWrite(1, encoder.encode("partial"));
    progress.acceptedWrite(2, encoder.encode("warning\n"));
    progress.compatibilityChecking();
  }
  expect(stages).toEqual([
    "cli-spawned",
    "cli-first-stdout-byte",
    "cli-stderr-bytes",
    "runtime-compatibility-checking",
  ]);
  expect(stages).not.toContain("control-response-received");
  progress.compatibilityConfirmed();
  progress.compatibilityConfirmed();
  expect(stages.filter((stage) => stage === "runtime-compatibility-confirmed")).toHaveLength(1);
});
