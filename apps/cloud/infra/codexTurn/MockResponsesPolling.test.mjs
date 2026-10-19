import * as NodeAssert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  CODEX_SECRET_READ_ARGUMENTS,
  CODEX_SECRET_READ_COMMAND,
  createMockResponses,
  createSecretPatchInput,
  FINAL_MESSAGE,
  PATCH_INPUT,
  SECRET_READ_CALL_ID,
} from "./MockResponses.mjs";

const EXEC_CALL_ID = "call-1069-exec";
const PATCH_CALL_ID = "call-1069-apply-patch";
const SESSION_ID = 49410;
const R7_RUNNING_OUTPUT =
  "Chunk ID: 7fe969\n" +
  "Wall time: 30.0000 seconds\n" +
  "Process running with session ID 49410\n" +
  "Original token count: 85\n" +
  "Output:\n" +
  "builtin-echo\n" +
  "external-echo\n" +
  "sh\n" +
  "cat\n" +
  "alpha\n" +
  "needle one\n" +
  "needle two\n" +
  "beta\n" +
  "a.b axb\n" +
  "head\n" +
  "alpha\n" +
  "needle one\n" +
  "tail\n" +
  "beta\n" +
  "a.b axb\n" +
  "sed\n" +
  "needle one\n" +
  "needle two\n" +
  "grep\n" +
  "2:thread one\n" +
  "3:thread two\n" +
  "rg\n" +
  "2:thread one\n" +
  "3:thread two\n" +
  "cp-mv\n" +
  "alpha\n" +
  "thread one\n" +
  "thread two\n" +
  "beta\n" +
  "a.b axb\n" +
  "ls\n" +
  "moved\n" +
  "pwd\n" +
  "canonical\n" +
  "external-printf\n" +
  "output:7\n" +
  "external-pwd\n" +
  "canonical\n" +
  "git\n" +
  "1\t0\ttracked.txt\n";
const R7_EXPECTED_STDOUT = `${R7_RUNNING_OUTPUT.slice(R7_RUNNING_OUTPUT.indexOf("Output:\n") + 8)}complete\n`;
const EXEC_ARGUMENTS = {
  cmd: "run official suite",
  login: false,
  tty: false,
  yield_time_ms: 30000,
  max_output_tokens: 4096,
};
const POLL_ARGUMENTS = {
  session_id: SESSION_ID,
  chars: "",
  yield_time_ms: 30000,
  max_output_tokens: 4096,
};
const PATCH_OUTPUT =
  "Exit code: 0\n" +
  "Wall Time: 0 seconds\n" +
  "Output:\n" +
  "Success. Updated the following files:\n" +
  "A /workspace/proof.txt\n";

function parseSse(text) {
  return text
    .trim()
    .split("\n\n")
    .map((block) => JSON.parse(block.match(/^data: (.+)$/m)[1]));
}

function outputFor(type, callId, output) {
  return { type, call_id: callId, output };
}

function formatExecOutput({ status, rawOutput, chunkId = "fixture-exec" }) {
  return [
    `Chunk ID: ${chunkId}`,
    "Wall time: 30.0000 seconds",
    status,
    `Original token count: ${new TextEncoder().encode(rawOutput).byteLength}`,
    "Output:",
    rawOutput,
  ].join("\n");
}

function execContinuation(output) {
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

function pollItems(pollNumber, output, args = POLL_ARGUMENTS) {
  const callId = `call-1069-write-stdin-${pollNumber}`;
  return [
    {
      type: "function_call",
      call_id: callId,
      name: "write_stdin",
      arguments: JSON.stringify(args),
    },
    outputFor("function_call_output", callId, output),
  ];
}

function startProgramSet(expected, options = {}) {
  const mock = createMockResponses({
    execCommand: { arguments: EXEC_ARGUMENTS, result: expected, running: true },
    ...options,
  });
  const exec = parseSse(
    mock.respond({ input: [{ type: "message", role: "user", content: [] }] }),
  )[1].item;
  NodeAssert.equal(exec.name, "exec_command");
  return mock;
}

function patchResult(mock) {
  const response = mock.respond({
    input: [
      { type: "custom_tool_call", call_id: PATCH_CALL_ID, name: "apply_patch", input: PATCH_INPUT },
      outputFor("custom_tool_call_output", PATCH_CALL_ID, PATCH_OUTPUT),
    ],
  });
  return parseSse(response)[1].item;
}

function secretReadContinuation(output) {
  return {
    input: [
      {
        type: "function_call",
        call_id: SECRET_READ_CALL_ID,
        name: "exec_command",
        arguments: JSON.stringify(CODEX_SECRET_READ_ARGUMENTS),
      },
      outputFor(
        "function_call_output",
        SECRET_READ_CALL_ID,
        `Process exited with code 0\nOutput:\n${output}`,
      ),
    ],
  };
}

test("a running exec polls once and verifies exact aggregate output before patch", () => {
  const expected = { exitCode: 0, stdout: R7_EXPECTED_STDOUT, stderr: "" };
  const mock = startProgramSet(expected);
  NodeAssert.equal(mock.postToolUseResponse, undefined);
  const pollEvents = parseSse(mock.respond(execContinuation(R7_RUNNING_OUTPUT)));

  NodeAssert.equal(pollEvents[0].response.id, "resp-1069-write-stdin-1");
  NodeAssert.deepEqual(pollEvents[1].item, {
    type: "function_call",
    call_id: "call-1069-write-stdin-1",
    name: "write_stdin",
    arguments: JSON.stringify(POLL_ARGUMENTS),
  });
  NodeAssert.equal(mock.phase, "awaiting-poll-output");

  const patch = parseSse(
    mock.respond({
      input: pollItems(1, "Process exited with code 0\nOutput:\ncomplete\n"),
    }),
  )[1].item;
  NodeAssert.equal(patch.name, "apply_patch");
  NodeAssert.deepEqual(mock.execution, expected);
  NodeAssert.equal(new TextEncoder().encode(mock.execution.stdout).byteLength, 348);
  NodeAssert.equal(mock.postToolUseResponse, "complete\n");
  NodeAssert.equal(patchResult(mock).content[0].text, FINAL_MESSAGE);
});

test("running exec keeps the secret patch/read flow and redacts its logged output", () => {
  const expected = { exitCode: 0, stdout: R7_EXPECTED_STDOUT, stderr: "" };
  const secretFile = {
    path: "/workspace/proof.txt",
    placeholderText: "API token: {{secret:API_TOKEN}}\n",
    readCommand: CODEX_SECRET_READ_COMMAND,
    expectedReadOutput: "API token: {{secret:API_TOKEN}}\n",
  };
  const mock = startProgramSet(expected, { secretFile });
  mock.respond(execContinuation(R7_RUNNING_OUTPUT));
  mock.respond({ input: pollItems(1, "Process exited with code 0\nOutput:\ncomplete\n") });

  const patchInput = createSecretPatchInput(secretFile.path, secretFile.placeholderText);
  const secretRead = parseSse(
    mock.respond({
      input: [
        {
          type: "custom_tool_call",
          call_id: PATCH_CALL_ID,
          name: "apply_patch",
          input: patchInput,
        },
        outputFor(
          "custom_tool_call_output",
          PATCH_CALL_ID,
          "Exit code: 0\nWall Time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nA /workspace/proof.txt\n",
        ),
      ],
    }),
  )[1].item;

  NodeAssert.equal(secretRead.call_id, SECRET_READ_CALL_ID);
  NodeAssert.equal(secretRead.arguments, JSON.stringify(CODEX_SECRET_READ_ARGUMENTS));
  const final = parseSse(mock.respond(secretReadContinuation(secretFile.expectedReadOutput)));
  NodeAssert.equal(final[1].item.content[0].text, FINAL_MESSAGE);
  NodeAssert.equal(mock.phase, "complete");
  NodeAssert.equal(mock.requests.length, 5);
  NodeAssert.equal(new TextEncoder().encode(mock.execution.stdout).byteLength, 348);
  NodeAssert.equal(mock.postToolUseResponse, "complete\n");
  NodeAssert.ok(!JSON.stringify(mock.requests).includes(secretFile.expectedReadOutput));
});

test("immediate completion exposes its full stdout only after exact validation", () => {
  const expected = { exitCode: 0, stdout: "full output\n", stderr: "" };
  const mock = startProgramSet(expected);
  const patch = parseSse(
    mock.respond(
      execContinuation(
        formatExecOutput({ status: "Process exited with code 0", rawOutput: expected.stdout }),
      ),
    ),
  )[1].item;

  NodeAssert.equal(patch.name, "apply_patch");
  NodeAssert.deepEqual(mock.execution, expected);
  NodeAssert.equal(mock.postToolUseResponse, expected.stdout);
});

test("multiple poll segments accumulate only their own bytes and use unique identities", () => {
  const expected = { exitCode: 0, stdout: "alpha\ncafé\nomega\n", stderr: "" };
  const mock = startProgramSet(expected);
  const execItems = execContinuation(
    formatExecOutput({
      status: `Process running with session ID ${SESSION_ID}`,
      rawOutput: "alpha\n",
    }),
  ).input;
  parseSse(mock.respond({ input: execItems }));
  const firstPollItems = pollItems(
    1,
    formatExecOutput({
      status: `Process running with session ID ${SESSION_ID}`,
      rawOutput: "café\n",
    }),
  );
  const secondPollEvents = parseSse(mock.respond({ input: [...execItems, ...firstPollItems] }));
  const secondPoll = secondPollEvents[1].item;

  NodeAssert.equal(secondPollEvents[0].response.id, "resp-1069-write-stdin-2");
  NodeAssert.equal(secondPoll.call_id, "call-1069-write-stdin-2");
  NodeAssert.notEqual(secondPoll.call_id, "call-1069-write-stdin-1");

  const patch = parseSse(
    mock.respond({
      input: [
        ...execItems,
        ...firstPollItems,
        ...pollItems(
          2,
          formatExecOutput({ status: "Process exited with code 0", rawOutput: "omega\n" }),
        ),
      ],
    }),
  )[1].item;
  NodeAssert.equal(patch.name, "apply_patch");
  NodeAssert.deepEqual(mock.execution, expected);
});

test("poll calls and running outputs must keep the exact session", () => {
  const mock = startProgramSet({ exitCode: 0, stdout: "done\n", stderr: "" });
  mock.respond(
    execContinuation(
      formatExecOutput({ status: `Process running with session ID ${SESSION_ID}`, rawOutput: "" }),
    ),
  );

  NodeAssert.throws(
    () =>
      mock.respond({
        input: pollItems(
          1,
          formatExecOutput({ status: "Process exited with code 0", rawOutput: "done\n" }),
          { ...POLL_ARGUMENTS, session_id: SESSION_ID + 1 },
        ),
      }),
    /arguments did not match the latest poll/,
  );
  NodeAssert.throws(
    () =>
      mock.respond({
        input: pollItems(
          1,
          formatExecOutput({
            status: `Process running with session ID ${SESSION_ID + 1}`,
            rawOutput: "",
          }),
        ),
      }),
    /different session ID/,
  );
  NodeAssert.equal(mock.phase, "awaiting-poll-output");
  NodeAssert.equal(mock.execution, undefined);
  NodeAssert.equal(mock.postToolUseResponse, undefined);
});

test("missing, malformed, and duplicate poll output fail closed", () => {
  const mock = startProgramSet({ exitCode: 0, stdout: "done\n", stderr: "" });
  mock.respond(
    execContinuation(
      formatExecOutput({ status: `Process running with session ID ${SESSION_ID}`, rawOutput: "" }),
    ),
  );

  const callOnly = pollItems(1, "")[0];
  NodeAssert.throws(
    () => mock.respond({ input: [callOnly] }),
    /exactly one .*function_call_output/,
  );
  NodeAssert.throws(
    () => mock.respond({ input: pollItems(1, "Process exited with code 0\nOutput:done\n") }),
    /exactly one Output section/,
  );
  const duplicate = pollItems(
    1,
    formatExecOutput({ status: "Process exited with code 0", rawOutput: "done\n" }),
  );
  duplicate.push(duplicate[1]);
  NodeAssert.throws(
    () => mock.respond({ input: duplicate }),
    /duplicate write_stdin function_call_output/,
  );
  NodeAssert.equal(mock.phase, "awaiting-poll-output");
  NodeAssert.equal(mock.postToolUseResponse, undefined);
});

test("poll byte mismatch, byte overflow, and more than three polls never reach patch", () => {
  const mismatch = startProgramSet({ exitCode: 0, stdout: "yes\n", stderr: "" });
  mismatch.respond(
    execContinuation(
      formatExecOutput({ status: `Process running with session ID ${SESSION_ID}`, rawOutput: "" }),
    ),
  );
  NodeAssert.throws(
    () =>
      mismatch.respond({
        input: pollItems(
          1,
          formatExecOutput({ status: "Process exited with code 0", rawOutput: "no!\n" }),
        ),
      }),
    /differed from the machine capture bytes/,
  );
  NodeAssert.equal(mismatch.phase, "awaiting-poll-output");
  NodeAssert.equal(mismatch.postToolUseResponse, undefined);

  const overflow = startProgramSet({ exitCode: 0, stdout: "ok\n", stderr: "" });
  overflow.respond(
    execContinuation(
      formatExecOutput({
        status: `Process running with session ID ${SESSION_ID}`,
        rawOutput: "ok\n",
      }),
    ),
  );
  NodeAssert.throws(
    () =>
      overflow.respond({
        input: pollItems(
          1,
          formatExecOutput({ status: "Process exited with code 0", rawOutput: "x" }),
        ),
      }),
    /exceeded the machine capture byte count/,
  );
  NodeAssert.equal(overflow.phase, "awaiting-poll-output");
  NodeAssert.equal(overflow.postToolUseResponse, undefined);

  const bounded = startProgramSet({ exitCode: 0, stdout: "1\n2\n3\n4\n", stderr: "" });
  bounded.respond(
    execContinuation(
      formatExecOutput({
        status: `Process running with session ID ${SESSION_ID}`,
        rawOutput: "1\n",
      }),
    ),
  );
  for (const [pollNumber, chunk] of [
    [1, "2\n"],
    [2, "3\n"],
  ]) {
    parseSse(
      bounded.respond({
        input: pollItems(
          pollNumber,
          formatExecOutput({
            status: `Process running with session ID ${SESSION_ID}`,
            rawOutput: chunk,
          }),
        ),
      }),
    );
  }
  NodeAssert.throws(
    () =>
      bounded.respond({
        input: pollItems(
          3,
          formatExecOutput({
            status: `Process running with session ID ${SESSION_ID}`,
            rawOutput: "4\n",
          }),
        ),
      }),
    /exceeded the 3-poll limit/,
  );
  NodeAssert.equal(bounded.phase, "awaiting-poll-output");
});
