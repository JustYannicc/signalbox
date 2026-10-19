import * as NodeAssert from "node:assert/strict";
import { test } from "vite-plus/test";

import { createMockResponses, FINAL_MESSAGE, PATCH_INPUT } from "./MockResponses.mjs";

const EXEC_CALL_ID = "call-1069-exec";
const PATCH_CALL_ID = "call-1069-apply-patch";
const EXEC_ARGUMENTS = {
  cmd: "printf '%s\\n' codex-exec-proof",
  login: false,
  tty: false,
  yield_time_ms: 1000,
  max_output_tokens: 100,
};
const EXEC_OUTPUT =
  "Chunk ID: exec-1069\n" +
  "Wall time: 0.0001 seconds\n" +
  "Process exited with code 0\n" +
  "Original token count: 1\n" +
  "Output:\n" +
  "codex-exec-proof\n";
const PATCH_OUTPUT =
  "Exit code: 0\n" +
  "Wall time: 0 seconds\n" +
  "Output:\n" +
  "Success. Updated the following files:\n" +
  "A /workspace/proof.txt\n";

function parseSse(text) {
  return text
    .trim()
    .split("\n\n")
    .map((block) => {
      const event = block.match(/^event: (.+)$/m)?.[1];
      const data = block.match(/^data: (.+)$/m)?.[1];
      NodeAssert.ok(event, `missing SSE event line in ${block}`);
      NodeAssert.ok(data, `missing SSE data line in ${block}`);
      const payload = JSON.parse(data);
      NodeAssert.equal(payload.type, event);
      return { event, payload };
    });
}

function outputFor(type, callId, output, name) {
  return {
    type,
    call_id: callId,
    ...(name ? { name } : {}),
    output,
  };
}

function execContinuation(output = EXEC_OUTPUT) {
  return {
    input: [
      {
        type: "function_call",
        call_id: EXEC_CALL_ID,
        name: "exec_command",
        arguments: JSON.stringify(EXEC_ARGUMENTS),
      },
      outputFor("function_call_output", EXEC_CALL_ID, output),
    ],
  };
}

function patchContinuation(output = PATCH_OUTPUT, includeName = true) {
  return {
    input: [
      {
        type: "custom_tool_call",
        call_id: PATCH_CALL_ID,
        name: "apply_patch",
        input: PATCH_INPUT,
      },
      outputFor(
        "custom_tool_call_output",
        PATCH_CALL_ID,
        output,
        includeName ? "apply_patch" : undefined,
      ),
    ],
  };
}

test("scripts exec_command, freeform apply_patch, and a final assistant message", () => {
  const mock = createMockResponses();
  const first = parseSse(
    mock.respond({
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Do the proof." }] },
      ],
    }),
  );

  NodeAssert.deepEqual(
    first.map(({ event }) => event),
    ["response.created", "response.output_item.done", "response.completed"],
  );
  NodeAssert.equal(first[0].payload.response.id, "resp-1069-exec");
  NodeAssert.deepEqual(first[2].payload.response.usage, {
    input_tokens: 0,
    input_tokens_details: null,
    output_tokens: 0,
    output_tokens_details: null,
    total_tokens: 0,
  });
  const functionCall = first[1].payload.item;
  NodeAssert.equal(functionCall.type, "function_call");
  NodeAssert.equal(functionCall.name, "exec_command");
  NodeAssert.deepEqual(JSON.parse(functionCall.arguments), EXEC_ARGUMENTS);
  NodeAssert.equal(mock.phase, "awaiting-exec-output");

  const second = parseSse(mock.respond(execContinuation()));
  NodeAssert.deepEqual(
    second.map(({ event }) => event),
    ["response.created", "response.output_item.done", "response.completed"],
  );
  NodeAssert.equal(second[1].payload.item.type, "custom_tool_call");
  NodeAssert.equal(second[1].payload.item.name, "apply_patch");
  NodeAssert.equal(second[1].payload.item.input, PATCH_INPUT);
  NodeAssert.equal(mock.phase, "awaiting-patch-output");

  const third = parseSse(mock.respond(patchContinuation()));
  NodeAssert.deepEqual(
    third.map(({ event }) => event),
    ["response.created", "response.output_item.done", "response.completed"],
  );
  NodeAssert.deepEqual(third[1].payload.item, {
    type: "message",
    id: "msg-1069-final",
    role: "assistant",
    content: [{ type: "output_text", text: FINAL_MESSAGE }],
  });
  NodeAssert.equal(mock.phase, "complete");
  NodeAssert.equal(mock.requests.length, 3);
  NodeAssert.throws(() => mock.respond({ input: [] }), /turn is complete/);
});

test("allows one empty-input startup response without advancing the forced turn", () => {
  const mock = createMockResponses();
  const startup = parseSse(mock.respond({ input: [] }));

  NodeAssert.deepEqual(
    startup.map(({ event }) => event),
    ["response.created", "response.completed"],
  );
  NodeAssert.equal(mock.startupRequestConsumed, true);
  NodeAssert.equal(mock.phase, "awaiting-exec-request");

  const turn = parseSse(mock.respond({ input: [{ type: "message", role: "user", content: [] }] }));
  NodeAssert.equal(turn[1].payload.item.name, "exec_command");
  NodeAssert.equal(mock.phase, "awaiting-exec-output");
  NodeAssert.throws(() => mock.respond({ input: [] }), /input must be an array|exactly one/);
});

test("rejects missing or failed exec output and leaves the expected step retryable", () => {
  const mock = createMockResponses();
  mock.respond({ input: [{ type: "message", role: "user", content: [] }] });

  NodeAssert.throws(
    () =>
      mock.respond({
        input: [
          {
            type: "function_call",
            call_id: EXEC_CALL_ID,
            name: "exec_command",
            arguments: JSON.stringify(EXEC_ARGUMENTS),
          },
        ],
      }),
    /exactly one function_call_output/,
  );
  NodeAssert.throws(
    () => mock.respond(execContinuation("Process exited with code 1\nOutput:\ncodex-exec-proof\n")),
    /exit code 0/,
  );
  NodeAssert.throws(
    () => mock.respond(execContinuation("Process exited with code 0\nOutput:\nwrong-output\n")),
    /exact stdout proof line/,
  );
  NodeAssert.equal(mock.phase, "awaiting-exec-output");

  NodeAssert.equal(parseSse(mock.respond(execContinuation()))[1].payload.item.name, "apply_patch");
});

test("requires the exact patch result before returning assistant done", () => {
  const mock = createMockResponses();
  mock.respond({ input: [{ type: "message", role: "user", content: [] }] });
  mock.respond(execContinuation());

  NodeAssert.throws(
    () => mock.respond(patchContinuation("Exit code: 1\nOutput:\nFailed to apply patch: denied")),
    /successful exit/,
  );
  NodeAssert.throws(
    () =>
      mock.respond(
        patchContinuation(
          "Exit code: 0\nOutput:\nSuccess. Updated the following files:\nA /workspace/other.txt\n",
        ),
      ),
    /did not confirm/,
  );
  NodeAssert.equal(mock.phase, "awaiting-patch-output");

  NodeAssert.equal(
    parseSse(mock.respond(patchContinuation(PATCH_OUTPUT, false)))[1].payload.item.content[0].text,
    FINAL_MESSAGE,
  );
});
