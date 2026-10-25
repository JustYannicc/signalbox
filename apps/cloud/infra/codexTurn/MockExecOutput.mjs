export const MAX_EXEC_POLLS = 3;

const encoder = new TextEncoder();

function exactlyOne(matches, description) {
  if (matches.length !== 1) {
    throw new Error(`exec_command output must contain exactly one ${description}`);
  }
  return matches[0];
}

function appendBytes(current, next) {
  const combined = new Uint8Array(current.byteLength + next.byteLength);
  combined.set(current);
  combined.set(next, current.byteLength);
  return combined;
}

function equalBytes(left, right) {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export function parseExecOutput(text) {
  if (typeof text !== "string") throw new TypeError("exec_command output must be a string");

  const outputHeader = exactlyOne([...text.matchAll(/^Output:\r?$/gm)], "Output section");
  const statuses = [
    ...[...text.matchAll(/^Process running with session ID (\d+)$/gm)].map((match) => ({
      kind: "running",
      value: match[1],
    })),
    ...[...text.matchAll(/^Process exited with code (-?\d+)$/gm)].map((match) => ({
      kind: "completed",
      value: match[1],
    })),
  ];
  const status = exactlyOne(statuses, "process status");

  const outputEnd = outputHeader.index + outputHeader[0].length;
  if (text[outputEnd] !== "\n")
    throw new Error("exec_command Output section had no body separator");
  const outputStart = outputEnd + 1;
  const rawOutput = text.slice(outputStart);
  const stderrMarkers = [...rawOutput.matchAll(/\r?\n\r?\nStandard [Ee]rror:\r?\n/g)];
  if (stderrMarkers.length > 1)
    throw new Error("exec_command output contains duplicate stderr sections");
  const stderrMarker = stderrMarkers[0];
  const stdout = stderrMarker ? rawOutput.slice(0, stderrMarker.index) : rawOutput;
  const stderr = stderrMarker ? rawOutput.slice(stderrMarker.index + stderrMarker[0].length) : "";

  if (status.kind === "running") {
    const sessionId = Number(status.value);
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) {
      throw new Error("exec_command running session ID was invalid");
    }
    return { status: "running", sessionId, stdout, stderr };
  }
  return { status: "completed", exitCode: Number(status.value), stdout, stderr };
}

export function createExecOutputTracker(expected) {
  if (
    !expected ||
    !Number.isSafeInteger(expected.exitCode) ||
    typeof expected.stdout !== "string" ||
    typeof expected.stderr !== "string"
  ) {
    throw new TypeError("running exec expectation requires exitCode, stdout and stderr");
  }
  const expectedBytes = {
    stdout: encoder.encode(expected.stdout),
    stderr: encoder.encode(expected.stderr),
  };
  let current = { stdout: new Uint8Array(), stderr: new Uint8Array() };

  function nextFor(chunk) {
    if (
      chunk.stdout.length > expectedBytes.stdout.byteLength - current.stdout.byteLength ||
      chunk.stderr.length > expectedBytes.stderr.byteLength - current.stderr.byteLength
    ) {
      throw new Error("exec_command output exceeded the machine capture byte count");
    }
    const next = {
      stdout: appendBytes(current.stdout, encoder.encode(chunk.stdout)),
      stderr: appendBytes(current.stderr, encoder.encode(chunk.stderr)),
    };
    if (
      next.stdout.byteLength > expectedBytes.stdout.byteLength ||
      next.stderr.byteLength > expectedBytes.stderr.byteLength
    ) {
      throw new Error("exec_command output exceeded the machine capture byte count");
    }
    return next;
  }

  function assertMatches(next, exitCode) {
    if (exitCode !== expected.exitCode) {
      throw new Error("exec_command output did not report the expected exit code");
    }
    if (
      !equalBytes(next.stdout, expectedBytes.stdout) ||
      !equalBytes(next.stderr, expectedBytes.stderr)
    ) {
      throw new Error("exec_command stdout or stderr differed from the machine capture bytes");
    }
  }

  return {
    append(chunk) {
      current = nextFor(chunk);
    },
    finish(chunk) {
      const next = nextFor(chunk);
      assertMatches(next, chunk.exitCode);
      current = next;
      return { exitCode: expected.exitCode, stdout: expected.stdout, stderr: expected.stderr };
    },
  };
}
