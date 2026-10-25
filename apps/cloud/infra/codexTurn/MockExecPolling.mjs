import { createExecOutputTracker, MAX_EXEC_POLLS, parseExecOutput } from "./MockExecOutput.mjs";

const WRITE_STDIN_CALL_PREFIX = "call-1069-write-stdin-";

function exactlyOne(items, description) {
  if (items.length !== 1) {
    throw new Error(`expected exactly one ${description}; found ${items.length}`);
  }
  return items[0];
}

function inputItems(body) {
  if (!Array.isArray(body?.input)) throw new Error("Responses request input must be an array");
  return body.input;
}

function outputText(item) {
  const output = item?.output;
  if (typeof output === "string") return output;
  if (
    Array.isArray(output) &&
    output.length === 1 &&
    output[0]?.type === "input_text" &&
    typeof output[0].text === "string"
  ) {
    return output[0].text;
  }
  throw new Error("write_stdin output must be a string or one input_text item");
}

function writeStdinArguments(sessionId) {
  return {
    session_id: sessionId,
    chars: "",
    yield_time_ms: 30000,
    max_output_tokens: 4096,
  };
}

function assertNoUnexpectedPollItems(body, latestPollCallId, issuedPollCallIds) {
  const input = inputItems(body);
  for (const item of input) {
    const callId = item?.call_id;
    const isPollCall = item?.type === "function_call" && item.name === "write_stdin";
    const isPollOutput = item?.type === "function_call_output" && item.name === "write_stdin";
    if (
      (isPollCall ||
        isPollOutput ||
        (typeof callId === "string" && callId.startsWith(WRITE_STDIN_CALL_PREFIX))) &&
      !issuedPollCallIds.has(callId)
    ) {
      throw new Error("write_stdin call did not match an issued poll ID");
    }
    if (
      issuedPollCallIds.has(callId) &&
      ((item?.type === "function_call" && item.name !== "write_stdin") ||
        (item?.type === "function_call_output" &&
          item.name !== undefined &&
          item.name !== "write_stdin"))
    ) {
      throw new Error("write_stdin history contained the wrong tool name");
    }
  }

  for (const callId of issuedPollCallIds) {
    for (const type of ["function_call", "function_call_output"]) {
      const matches = input.filter((item) => item?.type === type && item.call_id === callId);
      if (matches.length > 1) throw new Error(`duplicate write_stdin ${type} for ${callId}`);
    }
  }
}

export function createMockExecPolling(expected) {
  const tracker = createExecOutputTracker(expected);
  const issuedPollCallIds = new Set();
  let postToolUseResponse;
  let sessionId,
    pollCount = 0,
    latestPollCallId;

  function createPoll() {
    if (pollCount >= MAX_EXEC_POLLS) {
      throw new Error(`write_stdin exceeded the ${MAX_EXEC_POLLS}-poll limit`);
    }
    pollCount++;
    latestPollCallId = `${WRITE_STDIN_CALL_PREFIX}${pollCount}`;
    issuedPollCallIds.add(latestPollCallId);
    return {
      responseId: `resp-1069-write-stdin-${pollCount}`,
      call: {
        type: "function_call",
        call_id: latestPollCallId,
        name: "write_stdin",
        arguments: JSON.stringify(writeStdinArguments(sessionId)),
      },
    };
  }

  function accept(text) {
    const parsed = parseExecOutput(text);
    if (parsed.status === "completed") {
      const execution = tracker.finish(parsed);
      postToolUseResponse = parsed.stdout;
      return { status: "completed", execution };
    }
    if (sessionId !== undefined && parsed.sessionId !== sessionId) {
      throw new Error("write_stdin output reported a different session ID");
    }
    if (pollCount >= MAX_EXEC_POLLS) {
      throw new Error(`write_stdin exceeded the ${MAX_EXEC_POLLS}-poll limit`);
    }
    tracker.append(parsed);
    sessionId ??= parsed.sessionId;
    return { status: "running", poll: createPoll() };
  }

  return {
    acceptInitial: accept,
    acceptPoll(body) {
      assertNoUnexpectedPollItems(body, latestPollCallId, issuedPollCallIds);
      const call = exactlyOne(
        inputItems(body).filter(
          (item) => item?.type === "function_call" && item.call_id === latestPollCallId,
        ),
        "write_stdin function_call",
      );
      if (call.name !== "write_stdin" || typeof call.arguments !== "string") {
        throw new Error("write_stdin function_call did not match the latest poll");
      }
      let argumentsValue;
      try {
        argumentsValue = JSON.parse(call.arguments);
      } catch {
        throw new Error("write_stdin function_call arguments were not valid JSON");
      }
      const expectedArguments = writeStdinArguments(sessionId);
      if (
        JSON.stringify(Object.keys(argumentsValue ?? {}).sort()) !==
          JSON.stringify(Object.keys(expectedArguments).sort()) ||
        Object.entries(expectedArguments).some(([key, value]) => argumentsValue[key] !== value)
      ) {
        throw new Error("write_stdin function_call arguments did not match the latest poll");
      }
      const output = exactlyOne(
        inputItems(body).filter(
          (item) => item?.type === "function_call_output" && item.call_id === latestPollCallId,
        ),
        "write_stdin function_call_output",
      );
      if (output.name !== undefined && output.name !== "write_stdin") {
        throw new Error("write_stdin function_call_output had the wrong tool name");
      }
      return accept(outputText(output));
    },
    get postToolUseResponse() {
      return postToolUseResponse;
    },
  };
}
