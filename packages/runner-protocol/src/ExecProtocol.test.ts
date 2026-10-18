import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ExecCommand, ExecReport } from "./ExecProtocol.ts";

const decodeCommand = Schema.decodeUnknownSync(ExecCommand);
const decodeReport = Schema.decodeUnknownSync(ExecReport);

describe("Runner exec protocol", () => {
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
});
