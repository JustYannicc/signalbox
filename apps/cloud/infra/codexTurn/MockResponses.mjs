import { createMockExecPolling } from "./MockExecPolling.mjs";

const EXEC_CALL_ID = "call-1069-exec";
const PATCH_CALL_ID = "call-1069-apply-patch";
const SECRET_READ_CALL_ID = "call-1242-secret-read";

const EXEC_ARGUMENTS = Object.freeze({
  cmd: "printf '%s\\n' codex-exec-proof",
  login: false,
  tty: false,
  yield_time_ms: 1000,
  max_output_tokens: 100,
});

const PATCH_INPUT =
  "*** Begin Patch\n" +
  "*** Add File: /workspace/proof.txt\n" +
  "+codex-patch-proof\n" +
  "*** End Patch\n";

const CODEX_SECRET_FILE_PATH = "/workspace/proof.txt";
const CODEX_SECRET_READ_COMMAND = `cat ${CODEX_SECRET_FILE_PATH}`;
const CODEX_SECRET_READ_ARGUMENTS = Object.freeze({
  ...EXEC_ARGUMENTS,
  cmd: CODEX_SECRET_READ_COMMAND,
});

const EXEC_OUTPUT_MARKER = "codex-exec-proof";
const FINAL_MESSAGE = "Codex turn complete.";

function responseCreated(id) {
  return { type: "response.created", response: { id } };
}

function responseCompleted(id) {
  return {
    type: "response.completed",
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  };
}

function outputItemDone(item) {
  return { type: "response.output_item.done", item };
}

function toSse(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function response(id, item) {
  return toSse([
    responseCreated(id),
    ...(item ? [outputItemDone(item)] : []),
    responseCompleted(id),
  ]);
}

function asRequestBody(requestBody) {
  const parsed = typeof requestBody === "string" ? JSON.parse(requestBody) : requestBody;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("requestBody must be a JSON object or JSON object string");
  }
  return structuredClone(parsed);
}

function requestInput(body) {
  if (!Array.isArray(body.input)) {
    throw new Error("Responses request input must be an array");
  }
  return body.input;
}

function exactlyOne(items, description) {
  if (items.length !== 1) {
    throw new Error(`expected exactly one ${description}; found ${items.length}`);
  }
  return items[0];
}

function inputItem(body, type, callId) {
  const matches = requestInput(body).filter(
    (item) => item?.type === type && item?.call_id === callId,
  );
  return exactlyOne(matches, `${type} for ${callId}`);
}

function outputText(item, description) {
  const output = item.output;
  if (typeof output === "string") return output;
  if (
    Array.isArray(output) &&
    output.length === 1 &&
    output[0]?.type === "input_text" &&
    typeof output[0].text === "string"
  ) {
    return output[0].text;
  }
  throw new Error(`${description} output must be a string or one input_text item`);
}

export function createSecretPatchInput(path, content) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new TypeError("secret file path must be absolute");
  }
  if (typeof content !== "string") throw new TypeError("secret file content must be a string");
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  return [
    "*** Begin Patch",
    `*** Add File: ${path}`,
    ...lines.map((line) => `+${line}`),
    "*** End Patch",
    "",
  ].join("\n");
}

function assertExecCall(body, expectation) {
  const call = inputItem(body, "function_call", EXEC_CALL_ID);
  if (call.name !== "exec_command" || typeof call.arguments !== "string") {
    throw new Error("exec_command function_call did not match the forced call");
  }

  let argumentsValue;
  try {
    argumentsValue = JSON.parse(call.arguments);
  } catch {
    throw new Error("exec_command function_call arguments were not valid JSON");
  }
  const argumentKeys = Object.keys(argumentsValue ?? {}).sort();
  const expectedKeys = Object.keys(expectation.arguments).sort();
  if (
    JSON.stringify(argumentKeys) !== JSON.stringify(expectedKeys) ||
    Object.entries(expectation.arguments).some(([key, value]) => argumentsValue[key] !== value)
  ) {
    throw new Error("exec_command function_call arguments did not match the forced command");
  }

  const output = inputItem(body, "function_call_output", EXEC_CALL_ID);
  return outputText(output, "exec_command");
}

function assertExecCallAndOutput(body, expectation) {
  const text = assertExecCall(body, expectation);
  const exitCodes = [...text.matchAll(/^Process exited with code (-?\d+)$/gm)];
  if (exitCodes.length !== 1 || Number(exitCodes[0][1]) !== expectation.result.exitCode) {
    if (expectation.result.exitCode === 0) {
      throw new Error("exec_command output did not report exit code 0");
    }
    throw new Error("exec_command output did not report the expected exit code");
  }
  if (
    /^Process running with session ID /m.test(text) ||
    [...text.matchAll(/^Output:$/gm)].length !== 1
  ) {
    throw new Error("exec_command output did not contain one completed Output section");
  }
  const outputStart = text.indexOf("Output:\n");
  if (outputStart === -1) {
    throw new Error("exec_command output did not contain an Output section");
  }
  const captured = text.slice(outputStart + "Output:\n".length);
  const stderrMarker = /\r?\n\r?\nStandard [Ee]rror:\r?\n/;
  const stderrMatch = stderrMarker.exec(captured);
  const stdout = stderrMatch ? captured.slice(0, stderrMatch.index) : captured;
  const stderr = stderrMatch ? captured.slice(stderrMatch.index + stderrMatch[0].length) : "";
  if (stdout !== expectation.result.stdout || stderr !== expectation.result.stderr) {
    if (expectation.result.stdout === `${EXEC_OUTPUT_MARKER}\n`) {
      throw new Error("exec_command output did not contain the exact stdout proof line");
    }
    throw new Error("exec_command stdout or stderr differed from the machine capture");
  }
  return { exitCode: Number(exitCodes[0][1]), stdout, stderr };
}

function assertPatchCallAndOutput(body, patchInput, outputPath) {
  const call = inputItem(body, "custom_tool_call", PATCH_CALL_ID);
  if (call.name !== "apply_patch" || call.input !== patchInput) {
    throw new Error("apply_patch custom_tool_call did not match the forced patch");
  }

  const output = inputItem(body, "custom_tool_call_output", PATCH_CALL_ID);
  if (output.name !== undefined && output.name !== "apply_patch") {
    throw new Error("apply_patch custom_tool_call_output had the wrong tool name");
  }
  const text = outputText(output, "apply_patch");
  if (!/^Exit code: 0$/m.test(text) || !/^Output:$/m.test(text)) {
    throw new Error("apply_patch output did not report a successful exit");
  }
  if (!/^Success\. Updated the following files:$/m.test(text)) {
    throw new Error("apply_patch output did not include Codex's success summary");
  }
  const changes = text.split("\n").filter((line) => /^[AMD] /.test(line));
  if (changes.length !== 1 || changes[0] !== `A ${outputPath}`) {
    throw new Error(`apply_patch output did not confirm ${outputPath}`);
  }
}

function assertSecretReadCallAndOutput(body, secretFile) {
  const call = inputItem(body, "function_call", SECRET_READ_CALL_ID);
  if (call.name !== "exec_command" || typeof call.arguments !== "string") {
    throw new Error("secret read exec_command function_call did not match the forced call");
  }
  let argumentsValue;
  try {
    argumentsValue = JSON.parse(call.arguments);
  } catch {
    throw new Error("secret read exec_command arguments were not valid JSON");
  }
  const expectedArguments = { ...CODEX_SECRET_READ_ARGUMENTS, cmd: secretFile.readCommand };
  const argumentKeys = Object.keys(argumentsValue ?? {}).sort();
  const expectedKeys = Object.keys(expectedArguments).sort();
  if (
    JSON.stringify(argumentKeys) !== JSON.stringify(expectedKeys) ||
    Object.entries(expectedArguments).some(([key, value]) => argumentsValue[key] !== value)
  ) {
    throw new Error("secret read exec_command arguments did not match the forced command");
  }

  const output = inputItem(body, "function_call_output", SECRET_READ_CALL_ID);
  const text = outputText(output, "secret read exec_command");
  const exitCodes = [...text.matchAll(/^Process exited with code (-?\d+)$/gm)];
  const expectedContent = secretFile.expectedReadOutput ?? secretFile.placeholderText;
  const stdout = text.match(/(?:^|\r?\n)Output:\r?\n([\s\S]*)$/)?.[1];
  if (
    exitCodes.length !== 1 ||
    exitCodes[0][1] !== "0" ||
    /^Process running with session ID /m.test(text) ||
    stdout !== expectedContent
  ) {
    throw new Error("secret read exec_command output differed from the placeholder-only wire text");
  }
}

function emptyStartupRequest(body) {
  return Array.isArray(body.input) && body.input.length === 0;
}

function requestForLog(body, secretFile) {
  if (!secretFile) return body;
  const copy = structuredClone(body);
  if (Array.isArray(copy.input)) {
    for (const item of copy.input) {
      if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") {
        item.output = "[tool output omitted from secret proof log]";
      }
    }
  }
  return copy;
}

/**
 * Creates a local, deterministic Responses API fixture. It performs no I/O and
 * has no network client; callers pass decoded request bodies to respond().
 */
export function createMockResponses(options = {}) {
  const secretFile = options.secretFile;
  const execExpectation = options.execCommand ?? {
    arguments: EXEC_ARGUMENTS,
    result: { exitCode: 0, stdout: `${EXEC_OUTPUT_MARKER}\n`, stderr: "" },
  };
  if (
    typeof execExpectation !== "object" ||
    execExpectation === null ||
    typeof execExpectation.arguments !== "object" ||
    execExpectation.arguments === null ||
    typeof execExpectation.result !== "object" ||
    execExpectation.result === null ||
    !Number.isSafeInteger(execExpectation.result.exitCode) ||
    typeof execExpectation.result.stdout !== "string" ||
    typeof execExpectation.result.stderr !== "string"
  ) {
    throw new TypeError("execCommand requires arguments and an exitCode/stdout/stderr result");
  }
  if (execExpectation.running !== undefined && typeof execExpectation.running !== "boolean") {
    throw new TypeError("execCommand.running must be a boolean");
  }
  const runningExec = execExpectation.running === true;
  const execPolling = runningExec ? createMockExecPolling(execExpectation.result) : undefined;
  if (
    secretFile !== undefined &&
    (typeof secretFile !== "object" ||
      typeof secretFile.path !== "string" ||
      typeof secretFile.placeholderText !== "string" ||
      typeof secretFile.readCommand !== "string" ||
      secretFile.readCommand.length === 0)
  ) {
    throw new TypeError("secretFile requires path, placeholderText, and readCommand strings");
  }
  const patchInput = secretFile
    ? createSecretPatchInput(secretFile.path, secretFile.placeholderText)
    : PATCH_INPUT;
  const requests = [];
  let phase = "awaiting-exec-request";
  let startupRequestConsumed = false;
  let execution, postToolUseResponse;

  function issuePoll(poll) {
    phase = "awaiting-poll-output";
    return response(poll.responseId, poll.call);
  }

  function patchRequest() {
    phase = "awaiting-patch-output";
    return response("resp-1069-patch", {
      type: "custom_tool_call",
      call_id: PATCH_CALL_ID,
      name: "apply_patch",
      input: patchInput,
    });
  }

  function respond(requestBody) {
    const body = asRequestBody(requestBody);
    requests.push(requestForLog(body, secretFile));

    if (phase === "awaiting-exec-request" && !startupRequestConsumed && emptyStartupRequest(body)) {
      startupRequestConsumed = true;
      return response("resp-1069-startup");
    }

    if (phase === "awaiting-exec-request") {
      requestInput(body);
      phase = "awaiting-exec-output";
      return response("resp-1069-exec", {
        type: "function_call",
        call_id: EXEC_CALL_ID,
        name: "exec_command",
        arguments: JSON.stringify(execExpectation.arguments),
      });
    }

    if (phase === "awaiting-exec-output") {
      if (runningExec) {
        const result = execPolling.acceptInitial(assertExecCall(body, execExpectation));
        if (result.status === "running") return issuePoll(result.poll);
        execution = result.execution;
      } else {
        execution = assertExecCallAndOutput(body, execExpectation);
        postToolUseResponse = execution.stdout;
      }
      return patchRequest();
    }

    if (phase === "awaiting-poll-output") {
      const result = execPolling.acceptPoll(body);
      if (result.status === "running") return issuePoll(result.poll);
      execution = result.execution;
      return patchRequest();
    }

    if (phase === "awaiting-patch-output") {
      assertPatchCallAndOutput(body, patchInput, secretFile?.path ?? "/workspace/proof.txt");
      if (secretFile) {
        phase = "awaiting-secret-read-output";
        return response("resp-1242-secret-read", {
          type: "function_call",
          call_id: SECRET_READ_CALL_ID,
          name: "exec_command",
          arguments: JSON.stringify({
            ...CODEX_SECRET_READ_ARGUMENTS,
            cmd: secretFile.readCommand,
          }),
        });
      }
      phase = "complete";
      return response("resp-1069-final", {
        type: "message",
        id: "msg-1069-final",
        role: "assistant",
        content: [{ type: "output_text", text: FINAL_MESSAGE }],
      });
    }

    if (phase === "awaiting-secret-read-output") {
      assertSecretReadCallAndOutput(body, secretFile);
      phase = "complete";
      return response("resp-1069-final", {
        type: "message",
        id: "msg-1069-final",
        role: "assistant",
        content: [{ type: "output_text", text: FINAL_MESSAGE }],
      });
    }

    throw new Error("forced Codex turn is complete; no further Responses request is allowed");
  }

  return {
    respond,
    requests,
    get phase() {
      return phase;
    },
    get startupRequestConsumed() {
      return startupRequestConsumed;
    },
    get execution() {
      return execution;
    },
    get postToolUseResponse() {
      return runningExec ? execPolling.postToolUseResponse : postToolUseResponse;
    },
  };
}

export {
  CODEX_SECRET_FILE_PATH,
  CODEX_SECRET_READ_ARGUMENTS,
  CODEX_SECRET_READ_COMMAND,
  EXEC_ARGUMENTS,
  FINAL_MESSAGE,
  PATCH_INPUT,
  SECRET_READ_CALL_ID,
};
