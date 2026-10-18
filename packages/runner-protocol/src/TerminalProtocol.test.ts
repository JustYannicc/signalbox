import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ThreadId } from "@t3tools/contracts";

import {
  TerminalCommand,
  terminalCommandFrame,
  terminalReportFrame,
  type TerminalCommandMessage,
  type TerminalReportMessage,
} from "@signalbox/runner-protocol/TerminalProtocol";

const decodeTerminalCommand = Schema.decodeUnknownSync(TerminalCommand);

describe("terminal runner protocol", () => {
  it("roundtrips terminal commands and authoritative error reports", () => {
    const command: TerminalCommandMessage = {
      type: "terminal.command",
      requestId: "request-1",
      command: {
        type: "open",
        threadId: ThreadId.make("thread-1"),
        terminalId: "term-1",
        generation: 1,
        leaseGeneration: 4,
        drive: { driveId: "drive-1", token: "drive-token", remoteToken: null },
        cols: 120,
        rows: 32,
      },
    };
    const report: TerminalReportMessage = {
      type: "terminal.report",
      report: {
        type: "event",
        terminalId: "term-1",
        generation: 1,
        leaseGeneration: 4,
        sequence: 1,
        event: { type: "error", message: "terminal input failed" },
      },
    };
    const writeLimit: TerminalReportMessage = {
      type: "terminal.report",
      report: {
        type: "result",
        requestId: "write-request-2",
        terminalId: "term-1",
        generation: 1,
        leaseGeneration: 4,
        commandId: "write-65537",
        result: {
          type: "error",
          code: "write_receipt_limit",
          message: "This terminal generation has reached its write receipt limit.",
        },
      },
    };

    expect(terminalCommandFrame.decode(terminalCommandFrame.encode(command))).toEqual(command);
    expect(terminalReportFrame.decode(terminalReportFrame.encode(report))).toEqual(report);
    expect(terminalReportFrame.decode(terminalReportFrame.encode(writeLimit))).toEqual(writeLimit);
  });

  it("rejects terminal commands with invalid dimensions or generations", () => {
    for (const invalid of [
      {
        type: "clear",
        threadId: "thread-1",
        terminalId: "term-1",
        generation: 0,
        leaseGeneration: 1,
      },
      {
        type: "resize",
        threadId: "thread-1",
        terminalId: "term-1",
        generation: 1,
        leaseGeneration: 1,
        cols: 0,
        rows: 30,
      },
    ]) {
      expect(() => decodeTerminalCommand(invalid)).toThrow();
    }
  });
});
