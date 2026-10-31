const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const MAX_MODEL_COMMAND_OUTPUT_BYTES = 8192;
const MAX_MODEL_COMMAND_ENVELOPE_BYTES = 16384;
const MAX_ENVELOPE_PREVIEW_CHARS = 512;
const MAX_OUTPUT_PREVIEW_CHARS = 256;

const envelopePattern =
  /^Chunk ID: ([A-Za-z0-9_-]{1,128})\r?\nWall time: (\d+(?:\.\d+)?) seconds\r?\nProcess exited with code (\d{1,3})\r?\nOriginal token count: (\d+)\r?\nOutput:\r?\n([\s\S]*)$/;

function redactPreview(value) {
  return value
    .replace(
      /\b(authorization|(?:api|access|refresh)[_-]?token|secret|password)\b\s*[:=]\s*([^\s,;]+)/gi,
      "$1=<REDACTED>",
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer <REDACTED>");
}

function rawCapture(value, outputBytes) {
  const envelopeBytes = new TextEncoder().encode(value).byteLength;
  return {
    status: null,
    exitCode: null,
    aggregatedOutputPreview: "",
    aggregatedOutputBytes: outputBytes ?? 0,
    aggregatedOutputTruncated: true,
    envelopeBytes,
    envelopePreview: redactPreview(value.slice(0, MAX_ENVELOPE_PREVIEW_CHARS)),
    envelopeTruncated: value.length > MAX_ENVELOPE_PREVIEW_CHARS,
  };
}

function fail(message, capture) {
  const error = new Error(message);
  if (capture !== undefined) error.capture = capture;
  throw error;
}

export function decodeModelCommandOutput(body, callId) {
  if (!record(body) || !Array.isArray(body.input))
    throw new Error("Codex model command result is missing its input frame");
  if (typeof callId !== "string" || callId.length === 0)
    throw new Error("Codex model command result has no expected call ID");

  if (body.input.length > 256)
    fail(`Codex model input exceeded the bounded frame count for ${callId}`, {
      inputItemCount: body.input.length,
      matchingOutputCount: null,
      status: null,
      exitCode: null,
    });
  const matches = body.input.filter(
    (item) => record(item) && item.type === "function_call_output" && item.call_id === callId,
  );
  if (matches.length !== 1)
    fail(`Expected one function_call_output for ${callId}, received ${matches.length}`, {
      inputItemCount: body.input.length,
      matchingOutputCount: matches.length,
      status: null,
      exitCode: null,
    });
  const output = matches[0].output;
  if (typeof output !== "string")
    fail(`Model command output for ${callId} is not the captured text envelope`, {
      status: null,
      exitCode: null,
      outputType: output === null ? "null" : Array.isArray(output) ? "array" : typeof output,
      outputKeys: record(output) ? Object.keys(output).slice(0, 16).sort() : [],
    });
  if (output.length > MAX_MODEL_COMMAND_ENVELOPE_BYTES)
    fail(`Model command output for ${callId} exceeded the bounded capture`, {
      status: null,
      exitCode: null,
      envelopeBytes: null,
      envelopeChars: output.length,
      envelopePreview: "",
      envelopeTruncated: true,
    });

  const envelopeBytes = new TextEncoder().encode(output).byteLength;
  if (envelopeBytes > MAX_MODEL_COMMAND_ENVELOPE_BYTES)
    fail(`Model command output for ${callId} exceeded the bounded capture`, {
      status: null,
      exitCode: null,
      envelopeBytes,
      envelopePreview: redactPreview(output.slice(0, MAX_ENVELOPE_PREVIEW_CHARS)),
      envelopeTruncated: true,
    });
  const match = envelopePattern.exec(output);
  if (!match)
    fail(
      `Model command output for ${callId} has an incomplete or malformed envelope`,
      rawCapture(output),
    );

  const exitCode = Number(match[3]);
  const originalTokenCount = Number(match[4]);
  const wallTimeSeconds = Number(match[2]);
  if (
    !Number.isSafeInteger(exitCode) ||
    !Number.isSafeInteger(originalTokenCount) ||
    !Number.isFinite(wallTimeSeconds)
  )
    fail(`Model command output for ${callId} has invalid envelope fields`, rawCapture(output));

  const commandOutput = match[5];
  const outputBytes = new TextEncoder().encode(commandOutput).byteLength;
  const capture = {
    status: exitCode === 0 ? "completed" : "failed",
    exitCode,
    aggregatedOutputPreview: redactPreview(commandOutput.slice(0, MAX_OUTPUT_PREVIEW_CHARS)),
    aggregatedOutputBytes: outputBytes,
    aggregatedOutputTruncated: commandOutput.length > MAX_OUTPUT_PREVIEW_CHARS,
    envelopeBytes,
    envelopePreview: redactPreview(output.slice(0, MAX_ENVELOPE_PREVIEW_CHARS)),
    envelopeTruncated: output.length > MAX_ENVELOPE_PREVIEW_CHARS,
  };
  if (outputBytes > MAX_MODEL_COMMAND_OUTPUT_BYTES)
    fail(
      `Command output exceeded the ${MAX_MODEL_COMMAND_OUTPUT_BYTES}-byte fixture capture bound for ${callId}`,
      capture,
    );

  return {
    callId,
    chunkId: match[1],
    wallTimeSeconds,
    originalTokenCount,
    ...capture,
    output: commandOutput,
  };
}
