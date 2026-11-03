import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ExecCommand, ExecReport } from "./ExecProtocol.ts";

const decodeCommand = Schema.decodeUnknownSync(ExecCommand);
const decodeReport = Schema.decodeUnknownSync(ExecReport);

describe("Runner exec protocol", () => {
  it("round trips inherited read-only files and accepts legacy starts without them", () => {
    const start = {
      type: "start",
      generation: 1,
      processId: "child",
      requestId: "start",
      executable: "/bin/cat",
      argv: ["cat", "/dev/fd/3"],
      cwd: "/workspace",
      env: {},
    };
    const inherited = {
      ...start,
      inheritedFds: [{ childFd: 3, path: "/workspace/file", flags: 0, offset: 0 }],
    };
    const encode = Schema.encodeSync(ExecCommand);
    expect(decodeCommand(JSON.parse(JSON.stringify(encode(decodeCommand(inherited)))))).toEqual(
      inherited,
    );
    expect(decodeCommand(start)).toEqual(start);
    expect(decodeCommand(start)).not.toHaveProperty("inheritedFds");
  });

  it("accepts byte payloads and numeric signals without rewriting their values", () => {
    const command = {
      type: "signal",
      generation: 3,
      processId: "process-1",
      requestId: "signal-1",
      signal: 15,
    } as const;
    const report = {
      type: "output",
      generation: 3,
      processId: "process-1",
      sequence: 1,
      stream: "stdout",
      dataBase64: "/wA=",
    } as const;

    expect(decodeCommand(command)).toEqual(command);
    expect(decodeReport(report)).toEqual(report);
    expect(
      decodeReport({
        type: "ack",
        generation: 3,
        processId: "process-1",
        operation: "start",
        requestId: "start-1",
        applied: false,
        error: {
          code: "workspace_not_ready",
          message: "The canonical workspace mount is unavailable.",
        },
      }),
    ).toMatchObject({ error: { code: "workspace_not_ready" } });
  });

  it("rejects unknown operations, malformed byte data and stale generation values", () => {
    for (const invalid of [
      {
        type: "exec",
        generation: 3,
        processId: "process-1",
        requestId: "signal-1",
        signal: 15,
      },
      {
        type: "signal",
        generation: 0,
        processId: "process-1",
        requestId: "signal-1",
        signal: 15,
      },
      {
        type: "stdin.write",
        generation: 3,
        processId: "process-1",
        writeId: "write-1",
        dataBase64: "not base64",
      },
    ]) {
      expect(() => decodeCommand(invalid)).toThrow();
    }

    expect(() =>
      decodeReport({
        type: "ack",
        generation: 3,
        processId: "process-1",
        operation: "unknown",
        requestId: "req-1",
        applied: false,
      }),
    ).toThrow();
  });

  it.each([
    { childFd: 2, path: "/workspace/file", flags: 0, offset: 0 },
    { childFd: 3, path: "relative/file", flags: 0, offset: 0 },
    { childFd: 3, path: "/workspace/file", flags: 1, offset: 0 },
    { childFd: 3, path: "/workspace/file", flags: 0, offset: -1 },
    { childFd: 3, path: "/workspace/../escape", flags: 0, offset: 0 },
    { childFd: 3, path: "/tmp/host-file", flags: 0, offset: 0 },
    { childFd: 3, path: "/workspace/file", flags: 0, offset: 1 },
    { childFd: 3, path: "/workspace/file", flags: 0, offset: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects an invalid inherited file mapping %j", (mapping) => {
    expect(() =>
      decodeCommand({
        type: "start",
        generation: 1,
        processId: "child",
        requestId: "start",
        executable: "/bin/cat",
        argv: ["cat"],
        cwd: "/workspace",
        env: {},
        inheritedFds: [mapping],
      }),
    ).toThrow();
  });
});
